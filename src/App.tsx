import React, { useState, useEffect, useCallback, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, query, where, updateDoc, arrayUnion, Firestore } from 'firebase/firestore';

// Global variables provided by the Canvas environment (these are for the platform's internal use)
declare const __app_id: string | undefined;
declare const __firebase_config: string | undefined;
declare const __initial_auth_token: string | undefined;

// Define the base URL for your backend service
// IMPORTANT: During local development (running 'npm run dev' and 'python app.py' locally),
// this should be 'http://127.0.0.1:5000'.
// When you deploy your React app to a public host (like Netlify),
// you MUST update this URL to the public URL of your DEPLOYED Flask backend on Google Cloud Run.
// Example: const BACKEND_URL = 'https://your-ufc-backend-api-xxxxxx-uc.a.run.app';
const BACKEND_URL = 'https://ufc-backend-api-1038505217453.us-central1.run.app/'; // <--- REMEMBER TO REPLACE THIS URL BEFORE DEPLOYING TO NETLIFY!

// All 11 official UFC weight classes as per UFC standards
const WEIGHT_CLASSES = [
  'Heavyweight', 'Light Heavyweight', 'Middleweight', 'Welterweight',
  'Lightweight', 'Featherweight', 'Bantamweight', 'Flyweight',
  'W.Bantamweight', 'W.Flyweight', 'W.Strawweight'
];

// DraftKings Fantasy Sports MMA Classic Scoring System
const DRAFTKINGS_SCORING = {
  "Moves": {
    "Strikes": "+0.2 Pts",
    "Significant Strikes": "+0.2 Pts",
    "Control Time": "+0.03 Pts/Second",
    "Takedown": "+5 Pts",
    "Reversal/Sweep": "+5 Pts",
    "Knockdown": "+10 Pts",
  },
  "Fight Conclusion Bonuses": {
    "1st Round Win": "+90 Pts",
    "2nd Round Win": "+70 Pts",
    "3rd Round Win": "+45 Pts",
    "4th Round Win": "+40 Pts",
    "5th Round Win": "+40 Pts",
    "Decision Win": "+30 Pts",
    "Quick Win Bonus (First round win in 60 seconds or less)": "+25 Pts",
  }
};

function App() {
  // State variables for Firebase, user, competition, and UI elements
  const [app, setApp] = useState<any | null>(null); // Firebase app instance
  const [db, setDb] = useState<Firestore | null>(null); // Firestore instance
  const [auth, setAuth] = useState<any | null>(null); // Firebase Auth instance
  const [userId, setUserId] = useState<string | null>(null); // Current user's ID
  const [displayName, setDisplayName] = useState<string>(''); // User's display name
  const [competitionName, setCompetitionName] = useState<string>(''); // Input for new/joining competition
  const [currentCompetition, setCurrentCompetition] = useState<any | null>(null); // Active competition details
  const [loading, setLoading] = useState<boolean>(true); // Overall loading state
  const [error, setError] = useState<string | null>(null); // Error messages
  const [message, setMessage] = useState<string | null>(null); // Info/success messages
  const [searchQuery, setSearchQuery] = useState<string>(''); // Search input for fighters
  const [allFighters, setAllFighters] = useState<any[]>([]); // List of all fighters from backend

  // State for draft timer
  const [timeLeft, setTimeLeft] = useState<number>(180); // Time left for current pick (3 minutes default)
  const timerRef = useRef<number | null>(null); // Ref to hold the timer interval ID

  // Effect to initialize Firebase and handle user authentication state
  useEffect(() => {
    try {
      // Safely get app_id and firebase_config from global variables or use defaults
      const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
      const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};

      // Initialize Firebase services
      const firebaseApp = initializeApp(firebaseConfig);
      const firestoreDb = getFirestore(firebaseApp);
      const firebaseAuth = getAuth(firebaseApp);

      // Store initialized services in state
      setApp(firebaseApp);
      setDb(firestoreDb);
      setAuth(firebaseAuth);

      // Set up authentication state listener
      const unsubscribe = onAuthStateChanged(firebaseAuth, async (user: User | null) => {
        if (user) {
          // If user is logged in, set their ID
          setUserId(user.uid);
          // Try to fetch existing display name or set a default
          const userDocRef = doc(firestoreDb, 'artifacts', appId, 'users', user.uid);
          const userDocSnap = await getDoc(userDocRef);
          if (userDocSnap.exists()) {
            setDisplayName(userDocSnap.data().displayName || `User_${user.uid.substring(0, 6)}`);
          } else {
            const defaultName = `User_${user.uid.substring(0, 6)}`;
            await setDoc(userDocRef, { displayName: defaultName }, { merge: true });
            setDisplayName(defaultName);
          }
        } else {
          // If no user, try to sign in with custom token (if provided by Canvas) or anonymously
          if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await signInWithCustomToken(firebaseAuth, __initial_auth_token);
          } else {
            await signInAnonymously(firebaseAuth);
          }
        }
      });

      // Cleanup function for the auth state listener
      return () => unsubscribe();

    } catch (err: any) {
      // Catch and display any errors during Firebase initialization or authentication
      console.error("Firebase initialization or authentication failed:", err);
      setError(`Failed to initialize Firebase: ${err.message}`);
      setLoading(false);
    }
  }, []); // Empty dependency array ensures this runs only once on component mount

  // Effect to fetch fighters from the backend API
  useEffect(() => {
    const fetchFighters = async () => {
      try {
        setLoading(true); // Set loading state while fetching
        const response = await fetch(`${BACKEND_URL}/fighters`); // Fetch from backend URL
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json(); // Parse JSON response
        setAllFighters(data); // Store fetched fighters in state
        setError(null); // Clear any previous errors
      } catch (err: any) {
        console.error("Failed to fetch fighters:", err);
        // Display error if fetching fails, guiding user to check backend
        setError(`Failed to load fighter data from backend: ${err.message}. Please ensure the Python backend is running.`);
      } finally {
        setLoading(false); // Clear loading state
      }
    };
    fetchFighters(); // Call the fetch function
  }, []); // Empty dependency array ensures this runs only once on component mount

  // Effect to set up real-time listener for the current competition from Firestore
  useEffect(() => {
    // Only proceed if Firestore DB and user ID are available
    if (!db || !userId) return;

    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Safely get appId
    // Query Firestore for competitions where the current user is a player
    const competitionsRef = collection(db, 'artifacts', appId, 'public', 'data', 'competitions');
    const q = query(competitionsRef, where('players', 'array-contains', userId));

    // Set up real-time snapshot listener
    const unsubscribe = onSnapshot(q, (snapshot: any) => { // snapshot is typed as any for flexibility
      if (!snapshot.empty) {
        // If a competition is found, update currentCompetition state
        const compDoc = snapshot.docs[0]; // Assuming user is in only one active competition
        setCurrentCompetition({ id: compDoc.id, ...compDoc.data() });
        const data = compDoc.data();
        // If draft is in progress, sync the timer based on start time
        if (data.status === 'in_progress' && data.currentPickStartTime) {
          const elapsed = Math.floor((Date.now() - data.currentPickStartTime) / 1000);
          const remaining = Math.max(0, 180 - elapsed); // 180 seconds = 3 minutes
          setTimeLeft(remaining);
        }
      } else {
        setCurrentCompetition(null); // No active competition found
      }
    }, (err: any) => { // Error handler for snapshot listener
      console.error("Error listening to competitions:", err);
      setError(`Failed to load competitions: ${err.message}`);
    });

    // Cleanup function for the snapshot listener
    return () => unsubscribe();
  }, [db, userId]); // Re-run if db or userId changes

  // Effect to manage the draft countdown timer
  useEffect(() => {
    // Only run timer if draft is in progress and it's the current user's turn
    if (currentCompetition?.status === 'in_progress' && currentCompetition?.currentPickerId === userId) {
      // Clear any existing timer to prevent multiple intervals
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      // Set a new interval to decrement time every second
      timerRef.current = window.setInterval(() => {
        setTimeLeft((prevTime) => {
          if (prevTime <= 1) {
            clearInterval(timerRef.current!); // Stop timer when it reaches 0
            // TODO: Implement auto-skip or random pick logic here
            return 0;
          }
          return prevTime - 1; // Decrement time
        });
      }, 1000);
    } else {
      // Clear timer if draft is not in progress or it's not user's turn
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }
    // Cleanup function for the timer interval
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [currentCompetition, userId]); // Re-run if competition state or user ID changes

  // Handler for changing the user's display name
  const handleDisplayNameChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    setDisplayName(newName); // Update local state immediately
    if (db && userId) { // Ensure db and userId are available
      const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Safely get appId
      try {
        // Update user's display name in their private user document
        const userDocRef = doc(db, 'artifacts', appId, 'users', userId);
        await setDoc(userDocRef, { displayName: newName }, { merge: true });
        // If part of a competition, also update their display name in the competition document
        if (currentCompetition && currentCompetition.playerNames && userId) {
          const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
          await updateDoc(competitionRef, {
            [`playerNames.${userId}`]: newName // Use computed property name for dynamic key
          });
        }
      } catch (err: any) {
        console.error("Error updating display name:", err);
        setError(`Failed to update display name: ${err.message}`);
      }
    }
  };

  // Function to create a new fantasy competition
  const createCompetition = async () => {
    // Validate inputs
    if (!db || !userId || !competitionName.trim()) {
      setError("Please enter a competition name and ensure you are authenticated.");
      return;
    }
    setLoading(true); // Set loading state
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Safely get appId
    try {
      // Create a new competition document in Firestore
      const competitionsRef = collection(db, 'artifacts', appId, 'public', 'data', 'competitions');
      const newCompetitionRef = doc(competitionsRef); // Firestore generates unique ID
      await setDoc(newCompetitionRef, {
        name: competitionName.trim(),
        players: [userId], // Add creator as first player
        playerNames: { [userId]: displayName }, // Map player ID to display name
        status: 'setup', // Initial status
        createdAt: Date.now(),
        draftOrder: [],
        currentPickIndex: 0,
        currentPickerId: null,
        currentPickStartTime: null,
        draftedFighters: {},
        scores: {},
        creatorId: userId // Store creator's ID
      });
      setCompetitionName(''); // Clear input field
      setError(null); // Clear errors
      setMessage(`Competition "${competitionName.trim()}" created! Share the Competition ID above to invite others.`);
    } catch (err: any) {
      console.error("Error creating competition:", err);
      setError(`Failed to create competition: ${err.message}`);
    } finally {
      setLoading(false); // Clear loading state
    }
  };

  // Function to join an existing fantasy competition
  const joinCompetition = async () => {
    // Validate inputs
    if (!db || !userId || !competitionName.trim()) {
      setError("Please enter a competition ID and ensure you are authenticated.");
      return;
    }
    setLoading(true); // Set loading state
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Safely get appId
    try {
      // Get the competition document by ID
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', competitionName.trim());
      const compDocSnap = await getDoc(competitionRef);

      if (compDocSnap.exists()) {
        const compData = compDocSnap.data();
        // Prevent joining if draft has already started
        if (compData.status !== 'setup') {
          setError("Cannot join: Draft has already started or completed for this competition.");
          setLoading(false);
          return;
        }
        // Add current user to players array if not already present
        if (!compData.players.includes(userId)) {
          await updateDoc(competitionRef, {
            players: arrayUnion(userId), // Atomically add user ID to array
            [`playerNames.${userId}`]: displayName // Add display name mapping
          });
          setMessage(`Successfully joined competition "${compData.name}"!`);
        } else {
          setMessage(`You are already in competition "${compData.name}".`);
        }
        setCompetitionName(''); // Clear input
        setError(null); // Clear errors
      } else {
        setError("Competition not found. Please check the ID."); // Competition not found
      }
    } catch (err: any) {
      console.error("Error joining competition:", err);
      setError(`Failed to join competition: ${err.message}`);
    } finally {
      setLoading(false); // Clear loading state
    }
  };

  // Helper function to generate snake draft order
  const generateSnakeDraftOrder = useCallback((players: string[], rounds: number) => {
    let order: string[] = [];
    for (let i = 0; i < rounds; i++) {
      if (i % 2 === 0) {
        order = order.concat(players); // Forward order
      } else {
        order = order.concat([...players].reverse()); // Reverse order
      }
    }
    return order;
  }, []); // Memoize function

  // Function to shuffle player order (only for creator in setup phase)
  const shufflePlayers = async () => {
    // Validate permissions and competition status
    if (!db || !currentCompetition || currentCompetition.creatorId !== userId) {
      setError("Only the competition creator can shuffle players.");
      return;
    }
    if (currentCompetition.status !== 'setup') {
      setError("Cannot shuffle players: Draft has already started.");
      return;
    }

    setLoading(true); // Set loading state
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Safely get appId
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      const shuffledPlayers = [...currentCompetition.players].sort(() => Math.random() - 0.5); // Shuffle array
      await updateDoc(competitionRef, { players: shuffledPlayers }); // Update Firestore
      setMessage("Player order shuffled!"); // Success message
      setError(null); // Clear errors
    }
    catch (err: any) {
      console.error("Error shuffling players:", err);
      setError(`Failed to shuffle players: ${err.message}`);
    } finally {
      setLoading(false); // Clear loading state
    }
  };

  // Function to manually move a player's position in the draft order (creator only)
  const movePlayer = async (playerToMoveId: string, direction: 'up' | 'down') => {
    // Validate permissions and competition status
    if (!db || !currentCompetition || currentCompetition.creatorId !== userId || currentCompetition.status !== 'setup') {
      setError("Only the competition creator can reorder players in setup phase.");
      return;
    }

    const players = [...currentCompetition.players]; // Create a mutable copy of players array
    const index = players.indexOf(playerToMoveId); // Find index of player to move

    if (index === -1) return; // Player not found

    // Perform the swap based on direction
    if (direction === 'up' && index > 0) {
      [players[index - 1], players[index]] = [players[index], players[index - 1]];
    } else if (direction === 'down' && index < players.length - 1) {
      [players[index + 1], players[index]] = [players[index], players[index + 1]];
    } else {
      return; // Cannot move further up or down
    }

    setLoading(true); // Set loading state
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Safely get appId
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      await updateDoc(competitionRef, { players: players }); // Update Firestore with new order
      setError(null); // Clear errors
    } catch (err: any) {
      console.error("Error reordering players:", err);
      setError(`Failed to reorder players: ${err.message}`);
    } finally {
      setLoading(false); // Clear loading state
    }
  };

  // Function to start the fantasy draft
  const startDraft = async () => {
    // Validate permissions and competition status
    if (!db || !currentCompetition || currentCompetition.creatorId !== userId) {
      setError("Only the competition creator can start the draft.");
      return;
    }
    if (currentCompetition.status !== 'setup') {
      setError("Draft has already started or completed.");
      return;
    }
    if (currentCompetition.players.length === 0) {
      setError("Cannot start draft: No players in the competition.");
      return;
    }

    setLoading(true); // Set loading state
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Safely get appId
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      const roundsPerPlayer = WEIGHT_CLASSES.length + 1; // 1 per weight class + 1 flex slot
      const draftOrder = generateSnakeDraftOrder(currentCompetition.players, roundsPerPlayer); // Generate snake draft order

      // Initialize an empty object to store drafted fighters for each player
      const initialDraftedFighters: { [key: string]: { [key: string]: any } } = {};
      currentCompetition.players.forEach((pId: string) => {
        initialDraftedFighters[pId] = {};
      });

      // Update Firestore to start the draft
      await updateDoc(competitionRef, {
        status: 'in_progress', // Set status to in_progress
        draftOrder: draftOrder, // Store the generated draft order
        currentPickIndex: 0, // Start from the first pick
        currentPickerId: draftOrder[0], // Set the first picker
        currentPickStartTime: Date.now(), // Record start time for timer
        draftedFighters: initialDraftedFighters, // Initialize drafted fighters structure
      });
      setError(null); // Clear errors
      setMessage("Draft has started!"); // Success message
    } catch (err: any) {
      console.error("Error starting draft:", err);
      setError(`Failed to start draft: ${err.message}`);
    } finally {
      setLoading(false); // Clear loading state
    }
  };

  // Function to handle a player making a draft pick
  const makePick = async (fighter: any) => {
    // Validate turn and draft status
    if (!db || !currentCompetition || currentCompetition.currentPickerId !== userId) {
      setError("It's not your turn to pick.");
      return;
    }
    if (currentCompetition.status !== 'in_progress') {
      setError("Draft is not in progress.");
      return;
    }

    const playerDraftedFighters = currentCompetition.draftedFighters?.[userId] || {}; // Get current player's drafted fighters with optional chaining
    const hasFlexPicked = !!playerDraftedFighters['Flex']; // Check if flex slot is filled
    const weightClassPicksCount = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex').length; // Count specific WC picks

    let assignedSlot: string | null = null; // Slot where the fighter will be assigned
    // Prepare fighter data including opponent and fight date
    let pickedFighterData = { id: fighter.id, name: fighter.name, weightClass: fighter.weightClass, imageUrl: fighter.imageUrl, opponent: fighter.opponent, fightDate: fighter.fightDate };

    // Prevent drafting the same fighter twice by the same player
    if (Object.values(playerDraftedFighters).some((f: any) => f.id === fighter.id)) {
      setError("You have already drafted this fighter.");
      return;
    }

    // Determine if the fighter's specific weight class slot is available
    const isWeightClassSlotAvailable = !playerDraftedFighters[fighter.weightClass] && WEIGHT_CLASSES.includes(fighter.weightClass);

    // Logic to assign fighter to a slot: prioritize specific weight class, then flex
    if (isWeightClassSlotAvailable && weightClassPicksCount < WEIGHT_CLASSES.length) {
        assignedSlot = fighter.weightClass;
    } else if (!hasFlexPicked) {
        assignedSlot = 'Flex';
    } else {
        setError("You have already picked a fighter for this weight class or your Flex slot is full.");
        return;
    }

    if (!assignedSlot) { // Should not happen if logic is correct
      setError("Could not assign fighter to a slot. This shouldn't happen.");
      return;
    }

    // Prevent drafting a fighter already picked by ANY player in the competition
    const allDraftedFighterIds = getUndraftedFighters(true); // Get IDs of all drafted fighters
    if (allDraftedFighterIds.includes(fighter.id)) {
      setError("This fighter has already been drafted by another player.");
      return;
    }

    setLoading(true); // Set loading state
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Safely get appId
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      const nextPickIndex = currentCompetition.currentPickIndex + 1;
      const nextPickerId = currentCompetition.draftOrder[nextPickIndex];
      // Determine new competition status (completed if all picks are made)
      const newStatus = nextPickIndex >= currentCompetition.draftOrder.length ? 'completed' : 'in_progress';

      // Update the drafted fighters object in Firestore
      const updatedDraftedFighters = {
        ...(currentCompetition.draftedFighters || {}), // Ensure it's an object, even if null/undefined
        [userId!]: { // Use non-null assertion '!' as userId is guaranteed by 'if (!db || !currentCompetition || currentCompetition.currentPickerId !== userId)' check
          ...playerDraftedFighters,
          [assignedSlot]: pickedFighterData // Assign fighter to the determined slot
        }
      };

      // Update the competition document in Firestore
      await updateDoc(competitionRef, {
        draftedFighters: updatedDraftedFighters,
        currentPickIndex: nextPickIndex,
        currentPickerId: nextPickerId || null, // Set next picker or null if draft completed
        currentPickStartTime: newStatus === 'in_progress' ? Date.now() : null, // Reset timer start time
        status: newStatus, // Update competition status
      });

      setTimeLeft(180); // Reset timer for the next pick
      setError(null); // Clear errors
      setMessage(`You drafted ${fighter.name} into your ${assignedSlot} slot!`); // Success message
    } catch (err: any) {
      console.error("Error making pick:", err);
      setError(`Failed to make pick: ${err.message}`);
    } finally {
      setLoading(false); // Clear loading state
    }
  };

  // Memoized function to get a list of undrafted fighters or all drafted fighter IDs
  const getUndraftedFighters = useCallback((returnDraftedIds: boolean = false) => {
    // Return empty array if competition or fighters data is not loaded
    if (!currentCompetition || allFighters.length === 0) return [];

    // Flatten all drafted fighters from all players into a single array of IDs
    const allDraftedFighterIds = Object.values(currentCompetition.draftedFighters || {}) // Ensure it's an object
                                      .flatMap((playerPicks: any) => Object.values(playerPicks))
                                      .map((f: any) => f.id);

    if (returnDraftedIds) {
      return allDraftedFighterIds; // Return only the IDs of drafted fighters
    } else {
      // Return fighters from the master list that are NOT in the drafted IDs list
      return allFighters.filter(fighter => !allDraftedFighterIds.includes(fighter.id));
    }
  }, [currentCompetition, allFighters]); // Re-run if competition or allFighters data changes

  // Memoized function to get fighters available for the current user's pick
  const getMyAvailablePicks = useCallback(() => {
    // Return empty array if conditions for picking are not met
    if (!currentCompetition || !userId || currentCompetition.currentPickerId !== userId || allFighters.length === 0) return [];

    const playerDraftedFighters = currentCompetition.draftedFighters?.[userId] || {}; // Current player's drafted fighters
    const playerPickedWeightClasses = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex'); // Specific weight classes picked

    const availableSpecificSlots = WEIGHT_CLASSES.filter(wc => !playerPickedWeightClasses.includes(wc)); // Weight classes not yet filled
    const flexSlotOpen = !playerDraftedFighters['Flex']; // Check if flex slot is open
    const weightClassPicksCount = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex').length; // Count of specific WC picks
    const requiredSpecificPicksRemaining = WEIGHT_CLASSES.length - weightClassPicksCount; // How many specific WCs still need to be picked

    const undraftedFighters = getUndraftedFighters(); // Get all fighters not yet drafted by anyone

    // Filter undrafted fighters based on current player's needs
    return undraftedFighters.filter(fighter => {
      // If a specific weight class slot is available and this fighter matches it, it's a valid pick
      if (availableSpecificSlots.includes(fighter.weightClass) && !playerDraftedFighters[fighter.weightClass]) {
        return true;
      }
      // If flex slot is open, and either all specific slots are filled OR this fighter's WC is already taken, allow for flex
      if (flexSlotOpen &&
          (requiredSpecificPicksRemaining === 0 || !availableSpecificSlots.includes(fighter.weightClass))) {
          return true;
      }
      return false; // Otherwise, not a valid pick for this turn
    });
  }, [currentCompetition, userId, allFighters, getUndraftedFighters]); // Re-run if dependencies change


  // Renders the current status of the draft (setup, in progress, completed)
  const renderDraftStatus = () => {
    if (!currentCompetition) return null; // Don't render if no competition is active

    // If draft is completed
    if (currentCompetition.status === 'completed') {
      return <p className="text-xl text-green-400 font-bold text-center mt-4">Draft Completed!</p>;
    }

    // If draft is in progress
    if (currentCompetition.status === 'in_progress') {
      const currentPickerName = currentCompetition.playerNames?.[currentCompetition.currentPickerId] || 'Unknown Player'; // Get current picker's name
      const isMyTurn = currentCompetition.currentPickerId === userId; // Check if it's current user's turn
      const minutes = Math.floor(timeLeft / 60); // Calculate minutes left
      const seconds = timeLeft % 60; // Calculate seconds left

      const playerDraftedFighters = currentCompetition.draftedFighters?.[userId] || {}; // Current player's drafted fighters
      const pickedWeightClasses = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex'); // Specific weight classes picked
      const missingWeightClasses = WEIGHT_CLASSES.filter(wc => !pickedWeightClasses.includes(wc)); // Missing specific weight classes
      const needsFlex = !playerDraftedFighters['Flex']; // Check if flex slot needs to be filled
      const weightClassPicksCount = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex').length; // Count of specific WC picks

      let nextPickRequirement = ''; // Message for next pick requirement
      if (weightClassPicksCount < WEIGHT_CLASSES.length) {
          nextPickRequirement = `Next: Pick a fighter for one of these weight classes: ${missingWeightClasses.join(', ')}`;
      } else if (needsFlex) {
          nextPickRequirement = `Next: Pick your Flex fighter (any weight class).`;
      } else {
          nextPickRequirement = `Waiting for other players to pick.`;
      }

      // Determine which fighters to display (available for pick or all undrafted) and filter by search query
      const fightersToDisplay = isMyTurn ? getMyAvailablePicks() : getUndraftedFighters();
      const filteredFighters = fightersToDisplay.filter(fighter =>
        fighter.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      return (
        <div className="mt-6 p-4 bg-gray-800 rounded-lg shadow-inner border border-gray-700">
          <h3 className="text-2xl font-bold text-center text-orange-300 mb-4">
            Draft In Progress!
          </h3>
          <p className="text-lg text-center mb-2">
            <span className="font-semibold">{currentPickerName}</span> is currently picking.
            {isMyTurn && <span className="ml-2 px-3 py-1 bg-blue-500 text-white rounded-full text-sm animate-pulse">YOUR TURN!</span>}
          </p>
          {isMyTurn && (
              <p className="text-md text-center text-gray-300 mb-3">
                  {nextPickRequirement}
              </p>
          )}

          <p className="text-3xl font-bold text-center text-purple-400 mb-4">
            Time left: {minutes.toString().padStart(2, '0')}:{seconds.toString().padStart(2, '0')}
          </p>

          <div className="text-center mb-4">
            Pick #{currentCompetition.currentPickIndex + 1} of {currentCompetition.draftOrder.length}
          </div>

          <div className="mt-4">
            <h4 className="text-xl font-semibold mb-3 text-orange-200">
              {isMyTurn ? 'Available Fighters for Your Pick:' : 'All Remaining Undrafted Fighters:'}
            </h4>
            <div className="mb-4">
                <input
                    type="text"
                    placeholder="Search Fighters..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full p-2 bg-gray-700 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 border border-gray-600"
                />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 h-96 overflow-y-auto pr-2 custom-scrollbar">
              {filteredFighters.length > 0 ? (
                filteredFighters.map((fighter: any) => (
                  <div
                    key={fighter.id}
                    className={`p-3 rounded-lg shadow-md flex flex-col items-start space-y-1 transition duration-200
                                ${isMyTurn ? 'bg-gray-600 cursor-pointer hover:bg-gray-500' : 'bg-gray-700 opacity-75 cursor-not-allowed'}`}
                    onClick={() => isMyTurn && makePick(fighter)}
                  >
                    <div className="flex items-center space-x-3 w-full">
                        <img src={fighter.imageUrl} alt={fighter.name} className="w-12 h-12 rounded-full object-cover border-2 border-gray-400"/>
                        <div>
                            <p className="font-semibold text-lg text-white">{fighter.name}</p>
                            <p className="text-sm text-gray-200">{fighter.weightClass}</p>
                        </div>
                    </div>
                    {fighter.hasScheduledBout && fighter.opponent && fighter.fightDate && (
                        <div className="text-xs text-gray-300 pl-16 -mt-2">
                            <p>vs. {fighter.opponent}</p>
                            <p>on {new Date(fighter.fightDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                        </div>
                    )}
                    {!fighter.hasScheduledBout && (
                        <p className="text-xs text-gray-300 pl-16 -mt-2">No Scheduled Bout</p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-center text-gray-400 col-span-full">No fighters found matching your search or available to pick.</p>
              )}
            </div>
          </div>

          <div className="mt-6">
            <h4 className="text-xl font-semibold mb-3 text-orange-200">Your Drafted Team:</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {WEIGHT_CLASSES.map(wc => (
                  <div key={wc} className="bg-gray-600 p-3 rounded-lg shadow-md">
                      <p className="font-bold text-gray-200">{wc}:</p>
                      {currentCompetition.draftedFighters?.[userId]?.[wc] ? (
                          <div className="flex items-center space-x-2 mt-1">
                              <img src={currentCompetition.draftedFighters[userId][wc].imageUrl || `https://placehold.co/40x40/555/ffffff?text=${currentCompetition.draftedFighters[userId][wc].name.substring(0,2)}`} alt={currentCompetition.draftedFighters[userId][wc].name} className="w-8 h-8 rounded-full object-cover border-2 border-gray-400"/>
                              <span className="text-white">{currentCompetition.draftedFighters[userId][wc].name}</span>
                          </div>
                      ) : (
                          <span className="text-gray-400 italic">Unfilled</span>
                      )}
                  </div>
              ))}
                <div className="bg-gray-600 p-3 rounded-lg shadow-md">
                    <p className="font-bold text-gray-200">Flex:</p>
                    {currentCompetition.draftedFighters?.[userId]?.['Flex'] ? (
                        <div className="flex items-center space-x-2 mt-1">
                            <img src={currentCompetition.draftedFighters[userId]['Flex'].imageUrl || `https://placehold.co/40x40/555/ffffff?text=${currentCompetition.draftedFighters[userId]['Flex'].name.substring(0,2)}`} alt={currentCompetition.draftedFighters[userId]['Flex'].name} className="w-8 h-8 rounded-full object-cover border-2 border-gray-400"/>
                            <span className="text-white">{currentCompetition.draftedFighters[userId]['Flex'].name} <span className="text-sm text-gray-300">({currentCompetition.draftedFighters[userId]['Flex'].weightClass})</span></span>
                        </div>
                    ) : (
                        <span className="text-gray-400 italic">Unfilled</span>
                    )}
                </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;