import React, { useState, useEffect, useCallback, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, query, where, updateDoc, arrayUnion } from 'firebase/firestore';

// Global variables provided by the Canvas environment
// These are typically provided by the hosting environment (like Canvas itself)
// When deploying to Netlify/Vercel, you might need to configure these as environment variables
// or remove them if not strictly needed for your deployed app's core functionality.
declare const __app_id: string | undefined;
declare const __firebase_config: string | undefined;
declare const __initial_auth_token: string | undefined;

// Define the base URL for your backend service
// IMPORTANT: During local development, this should be 'http://127.0.0.1:5000'.
// When you deploy your React app to a public host (Netlify/Vercel),
// you MUST update this URL to the public URL of your DEPLOYED Flask backend.
const BACKEND_URL = 'https://ufc-backend-api-1038505217453.us-central1.run.app'; // Keep this for local testing, update for deployment!

// All 11 official UFC weight classes
const WEIGHT_CLASSES = [
  'Heavyweight', 'Light Heavyweight', 'Middleweight', 'Welterweight',
  'Lightweight', 'Featherweight', 'Bantamweight', 'Flyweight',
  'W.Bantamweight', 'W.Flyweight', 'W.Strawweight'
];

// DraftKings Scoring System (for display)
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
  const [app, setApp] = useState<any>(null);
  const [db, setDb] = useState<any>(null);
  const [auth, setAuth] = useState<any>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>('');
  const [competitionName, setCompetitionName] = useState<string>('');
  const [currentCompetition, setCurrentCompetition] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null); // For general messages
  const [searchQuery, setSearchQuery] = useState<string>(''); // For fighter search
  const [allFighters, setAllFighters] = useState<any[]>([]); // State to store fetched fighters

  // Timer state for the draft
  const [timeLeft, setTimeLeft] = useState<number>(180); // Default 3 minutes
  const timerRef = useRef<number | null>(null);

  // Initialize Firebase and set up authentication
  useEffect(() => {
    try {
      // These global variables are for the Gemini Canvas environment.
      // For external deployment (Netlify/Vercel), you would typically
      // initialize Firebase with your actual Firebase project config
      // (e.g., from your Firebase project settings -> Web app -> Config).
      // You would store these config values as environment variables in your hosting platform.
      const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Fallback for local/non-Canvas
      const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
        apiKey: "YOUR_FIREBASE_API_KEY", // Replace with your actual Firebase API Key
        authDomain: "YOUR_FIREBASE_AUTH_DOMAIN",
        projectId: "YOUR_FIREBASE_PROJECT_ID",
        storageBucket: "YOUR_FIREBASE_STORAGE_BUCKET",
        messagingSenderId: "YOUR_FIREBASE_MESSAGING_SENDER_ID",
        appId: "YOUR_FIREBASE_APP_ID"
      };

      const firebaseApp = initializeApp(firebaseConfig);
      const firestoreDb = getFirestore(firebaseApp);
      const firebaseAuth = getAuth(firebaseApp);

      setApp(firebaseApp);
      setDb(firestoreDb);
      setAuth(firebaseAuth);

      const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
        if (user) {
          setUserId(user.uid);
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
          // For external deployment, you might use signInAnonymously directly
          // or implement a proper sign-up/login flow.
          // __initial_auth_token is specific to the Canvas environment.
          if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await signInWithCustomToken(firebaseAuth, __initial_auth_token);
          } else {
            await signInAnonymously(firebaseAuth);
          }
        }
      });

      return () => unsubscribe();

    } catch (err: any) {
      console.error("Firebase initialization or authentication failed:", err);
      setError(`Failed to initialize Firebase: ${err.message}`);
      setLoading(false);
    }
  }, []);

  // Fetch fighters from backend
  useEffect(() => {
    const fetchFighters = async () => {
      try {
        setLoading(true);
        const response = await fetch(`${BACKEND_URL}/fighters`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        setAllFighters(data);
        setError(null);
      } catch (err: any) {
        console.error("Failed to fetch fighters:", err);
        setError(`Failed to load fighter data from backend: ${err.message}. Please ensure the Python backend is running at ${BACKEND_URL}.`);
      } finally {
        setLoading(false);
      }
    };
    fetchFighters();
  }, []);

  // Set up real-time listener for current competition
  useEffect(() => {
    if (!db || !userId) return;

    // The __app_id is specific to the Canvas environment.
    // For external deployment, you might hardcode an app ID or fetch it differently.
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

    const competitionsRef = collection(db, 'artifacts', appId, 'public', 'data', 'competitions');
    const q = query(competitionsRef, where('players', 'array-contains', userId));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const compDoc = snapshot.docs[0];
        setCurrentCompetition({ id: compDoc.id, ...compDoc.data() });
        const data = compDoc.data();
        if (data.status === 'in_progress' && data.currentPickStartTime) {
          const elapsed = Math.floor((Date.now() - data.currentPickStartTime) / 1000);
          const remaining = Math.max(0, 180 - elapsed);
          setTimeLeft(remaining);
        }
      } else {
        setCurrentCompetition(null);
      }
    }, (err) => {
      console.error("Error listening to competitions:", err);
      setError(`Failed to load competitions: ${err.message}`);
    });

    return () => unsubscribe();
  }, [db, userId]);

  // Draft timer effect
  useEffect(() => {
    if (currentCompetition?.status === 'in_progress' && currentCompetition?.currentPickerId === userId) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      timerRef.current = window.setInterval(() => {
        setTimeLeft((prevTime) => {
          if (prevTime <= 1) {
            clearInterval(timerRef.current!);
            return 0;
          }
          return prevTime - 1;
        });
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [currentCompetition, userId]);

  // Handle display name change
  const handleDisplayNameChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    setDisplayName(newName);
    if (db && userId) {
      const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Fallback for local/non-Canvas
      try {
        const userDocRef = doc(db, 'artifacts', appId, 'users', userId);
        await setDoc(userDocRef, { displayName: newName }, { merge: true });
        if (currentCompetition && currentCompetition.playerNames[userId]) {
          const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
          await updateDoc(competitionRef, {
            [`playerNames.${userId}`]: newName
          });
        }
      } catch (err: any) {
        console.error("Error updating display name:", err);
        setError(`Failed to update display name: ${err.message}`);
      }
    }
  };

  // Create a new competition
  const createCompetition = async () => {
    if (!db || !userId || !competitionName.trim()) {
      setError("Please enter a competition name and ensure you are authenticated.");
      return;
    }
    setLoading(true);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Fallback for local/non-Canvas
    try {
      const competitionsRef = collection(db, 'artifacts', appId, 'public', 'data', 'competitions');
      const newCompetitionRef = doc(competitionsRef);
      await setDoc(newCompetitionRef, {
        name: competitionName.trim(),
        players: [userId],
        playerNames: { [userId]: displayName },
        status: 'setup',
        createdAt: Date.now(),
        draftOrder: [],
        currentPickIndex: 0,
        currentPickerId: null,
        currentPickStartTime: null,
        draftedFighters: {},
        scores: {},
        creatorId: userId
      });
      setCompetitionName('');
      setError(null);
      setMessage(`Competition "${competitionName.trim()}" created! Share the Competition ID above to invite others.`);
    } catch (err: any) {
      console.error("Error creating competition:", err);
      setError(`Failed to create competition: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Join an existing competition
  const joinCompetition = async () => {
    if (!db || !userId || !competitionName.trim()) {
      setError("Please enter a competition ID and ensure you are authenticated.");
      return;
    }
    setLoading(true);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Fallback for local/non-Canvas
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', competitionName.trim());
      const compDocSnap = await getDoc(competitionRef);

      if (compDocSnap.exists()) {
        const compData = compDocSnap.data();
        if (compData.status !== 'setup') {
          setError("Cannot join: Draft has already started or completed for this competition.");
          setLoading(false);
          return;
        }
        if (!compData.players.includes(userId)) {
          await updateDoc(competitionRef, {
            players: arrayUnion(userId),
            [`playerNames.${userId}`]: displayName
          });
          setMessage(`Successfully joined competition "${compData.name}"!`);
        } else {
          setMessage(`You are already in competition "${compData.name}".`);
        }
        setCompetitionName('');
        setError(null);
      } else {
        setError("Competition not found. Please check the ID.");
      }
    } catch (err: any) {
      console.error("Error joining competition:", err);
      setError(`Failed to join competition: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Function to generate snake draft order
  const generateSnakeDraftOrder = useCallback((players: string[], rounds: number) => {
    let order: string[] = [];
    for (let i = 0; i < rounds; i++) {
      if (i % 2 === 0) {
        order = order.concat(players);
      } else {
        order = order.concat([...players].reverse());
      }
    }
    return order;
  }, []);

  // Shuffle player order for draft
  const shufflePlayers = async () => {
    if (!db || !currentCompetition || currentCompetition.creatorId !== userId) {
      setError("Only the competition creator can shuffle players.");
      return;
    }
    if (currentCompetition.status !== 'setup') {
      setError("Cannot shuffle players: Draft has already started.");
      return;
    }

    setLoading(true);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Fallback for local/non-Canvas
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      const shuffledPlayers = [...currentCompetition.players].sort(() => Math.random() - 0.5);
      await updateDoc(competitionRef, { players: shuffledPlayers });
      setMessage("Player order shuffled!");
      setError(null);
    }
    catch (err: any) {
      console.error("Error shuffling players:", err);
      setError(`Failed to shuffle players: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Move player up/down in the list (for creator to manually set order)
  const movePlayer = async (playerToMoveId: string, direction: 'up' | 'down') => {
    if (!db || !currentCompetition || currentCompetition.creatorId !== userId || currentCompetition.status !== 'setup') {
      setError("Only the competition creator can reorder players in setup phase.");
      return;
    }

    const players = [...currentCompetition.players];
    const index = players.indexOf(playerToMoveId);

    if (index === -1) return;

    if (direction === 'up' && index > 0) {
      [players[index - 1], players[index]] = [players[index], players[index - 1]];
    } else if (direction === 'down' && index < players.length - 1) {
      [players[index + 1], players[index]] = [players[index], players[index + 1]];
    } else {
      return; // Can't move further up or down
    }

    setLoading(true);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Fallback for local/non-Canvas
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      await updateDoc(competitionRef, { players: players });
      setError(null);
    } catch (err: any) {
      console.error("Error reordering players:", err);
      setError(`Failed to reorder players: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };


  // Start the draft
  const startDraft = async () => {
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

    setLoading(true);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Fallback for local/non-Canvas
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      const roundsPerPlayer = WEIGHT_CLASSES.length + 1; // 1 for each weight class + 1 for flex
      const draftOrder = generateSnakeDraftOrder(currentCompetition.players, roundsPerPlayer);

      // Initialize drafted fighters for each player
      const initialDraftedFighters: { [key: string]: { [key: string]: any } } = {};
      currentCompetition.players.forEach((pId: string) => {
        initialDraftedFighters[pId] = {};
      });

      await updateDoc(competitionRef, {
        status: 'in_progress',
        draftOrder: draftOrder,
        currentPickIndex: 0,
        currentPickerId: draftOrder[0],
        currentPickStartTime: Date.now(),
        draftedFighters: initialDraftedFighters,
      });
      setError(null);
      setMessage("Draft has started!");
    } catch (err: any) {
      console.error("Error starting draft:", err);
      setError(`Failed to start draft: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Make a draft pick
  const makePick = async (fighter: any) => {
    if (!db || !currentCompetition || currentCompetition.currentPickerId !== userId) {
      setError("It's not your turn to pick.");
      return;
    }
    if (currentCompetition.status !== 'in_progress') {
      setError("Draft is not in progress.");
      return;
    }

    const playerDraftedFighters = currentCompetition.draftedFighters[userId] || {};
    const hasFlexPicked = !!playerDraftedFighters['Flex'];
    const weightClassPicksCount = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex').length;

    let assignedSlot: string | null = null;
    let pickedFighterData = { id: fighter.id, name: fighter.name, weightClass: fighter.weightClass, imageUrl: fighter.imageUrl, opponent: fighter.opponent, fightDate: fighter.fightDate };

    // Check if player already has this specific fighter drafted
    if (Object.values(playerDraftedFighters).some((f: any) => f.id === fighter.id)) {
      setError("You have already drafted this fighter.");
      return;
    }

    // Check if this fighter's specific weight class slot is available for a direct pick
    const isWeightClassSlotAvailable = !playerDraftedFighters[fighter.weightClass] && WEIGHT_CLASSES.includes(fighter.weightClass);

    if (isWeightClassSlotAvailable && weightClassPicksCount < WEIGHT_CLASSES.length) {
        // Prioritize filling the specific weight class slot
        assignedSlot = fighter.weightClass;
    } else if (!hasFlexPicked) {
        // If the specific weight class slot is taken OR all specific weight class slots are filled,
        // and the flex slot is open, assign to Flex.
        assignedSlot = 'Flex';
    } else {
        setError("You have already picked a fighter for this weight class or your Flex slot is full.");
        return;
    }

    if (!assignedSlot) {
      setError("Could not assign fighter to a slot. This shouldn't happen.");
      return;
    }

    // Check if fighter is already drafted by anyone across the entire competition
    const allDraftedFighterIds = getUndraftedFighters(true); // true to get ALL drafted IDs
    if (allDraftedFighterIds.includes(fighter.id)) {
      setError("This fighter has already been drafted by another player.");
      return;
    }

    setLoading(true);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Fallback for local/non-Canvas
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      const nextPickIndex = currentCompetition.currentPickIndex + 1;
      const nextPickerId = currentCompetition.draftOrder[nextPickIndex];
      const newStatus = nextPickIndex >= currentCompetition.draftOrder.length ? 'completed' : 'in_progress';

      // Update drafted fighters for the current player
      const updatedDraftedFighters = {
        ...currentCompetition.draftedFighters,
        [userId]: {
          ...playerDraftedFighters,
          [assignedSlot]: pickedFighterData // Store the fighter object
        }
      };

      await updateDoc(competitionRef, {
        draftedFighters: updatedDraftedFighters,
        currentPickIndex: nextPickIndex,
        currentPickerId: nextPickerId || null, // Null if draft completed
        currentPickStartTime: newStatus === 'in_progress' ? Date.now() : null,
        status: newStatus,
      });

      setTimeLeft(180); // Reset timer for next pick
      setError(null);
      setMessage(`You drafted ${fighter.name} into your ${assignedSlot} slot!`);
    } catch (err: any) {
      console.error("Error making pick:", err);
      setError(`Failed to make pick: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Returns true for all drafted fighter IDs, or false for available fighters
  const getUndraftedFighters = useCallback((returnDraftedIds: boolean = false) => {
    if (!currentCompetition || allFighters.length === 0) return []; // Ensure allFighters is loaded

    const allDraftedFighterIds = Object.values(currentCompetition.draftedFighters)
                                      .flatMap((playerPicks: any) => Object.values(playerPicks))
                                      .map((f: any) => f.id);

    if (returnDraftedIds) {
      return allDraftedFighterIds;
    } else {
      return allFighters.filter(fighter => !allDraftedFighterIds.includes(fighter.id));
    }
  }, [currentCompetition, allFighters]);

  const getMyAvailablePicks = useCallback(() => {
    if (!currentCompetition || !userId || currentCompetition.currentPickerId !== userId || allFighters.length === 0) return [];

    const playerDraftedFighters = currentCompetition.draftedFighters[userId] || {};
    const playerPickedWeightClasses = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex');

    const availableSpecificSlots = WEIGHT_CLASSES.filter(wc => !playerPickedWeightClasses.includes(wc));
    const flexSlotOpen = !playerDraftedFighters['Flex'];
    const weightClassPicksCount = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex').length;
    const requiredSpecificPicksRemaining = WEIGHT_CLASSES.length - weightClassPicksCount;

    const undraftedFighters = getUndraftedFighters();

    return undraftedFighters.filter(fighter => {
      if (availableSpecificSlots.includes(fighter.weightClass) && !playerDraftedFighters[fighter.weightClass]) {
        return true;
      }
      if (flexSlotOpen &&
          (requiredSpecificPicksRemaining === 0 || !availableSpecificSlots.includes(fighter.weightClass))) {
          return true;
      }
      return false;
    });
  }, [currentCompetition, userId, allFighters, getUndraftedFighters]);


  const renderDraftStatus = () => {
    if (!currentCompetition) return null;

    if (currentCompetition.status === 'completed') {
      return <p className="text-xl text-green-400 font-bold text-center mt-4">Draft Completed!</p>;
    }

    if (currentCompetition.status === 'in_progress') {
      const currentPickerName = currentCompetition.playerNames[currentCompetition.currentPickerId] || 'Unknown Player';
      const isMyTurn = currentCompetition.currentPickerId === userId;
      const minutes = Math.floor(timeLeft / 60);
      const seconds = timeLeft % 60;

      const playerDraftedFighters = currentCompetition.draftedFighters[userId] || {};
      const pickedWeightClasses = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex');
      const missingWeightClasses = WEIGHT_CLASSES.filter(wc => !pickedWeightClasses.includes(wc));
      const needsFlex = !playerDraftedFighters['Flex'];
      const weightClassPicksCount = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex').length;

      let nextPickRequirement = '';
      if (weightClassPicksCount < WEIGHT_CLASSES.length) {
          nextPickRequirement = `Next: Pick a fighter for one of these weight classes: ${missingWeightClasses.join(', ')}`;
      } else if (needsFlex) {
          nextPickRequirement = `Next: Pick your Flex fighter (any weight class).`;
      } else {
          nextPickRequirement = `Waiting for other players to pick.`;
      }

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
                      {currentCompetition.draftedFighters[userId]?.[wc] ? (
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
                    {currentCompetition.draftedFighters[userId]?.['Flex'] ? (
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
        </div>
      );
    }
    return null;
  };


  if (loading || !allFighters.length) { // Check both Firebase auth and fighter data loading
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <p className="text-xl text-gray-700">
          {error ? error : "Loading app and fighter data. Please ensure your Python backend is running on port 5000..."}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-700 text-white font-inter p-4 sm:p-6 md:p-8">
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet" />

      <style>{`
        body { font-family: 'Inter', sans-serif; }
        .custom-scrollbar::-webkit-scrollbar {
            width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
            background: #4a4a4a;
            border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
            background: #888;
            border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: #555;
        }
      `}</style>

      <div className="max-w-4xl mx-auto bg-gray-800 rounded-xl shadow-lg p-6 sm:p-8 md:p-10 border border-gray-700">
        <h1 className="text-3xl sm:text-4xl font-bold text-center mb-6 text-orange-400">
          Fantasy UFC Competition
        </h1>

        {error && (
          <div className="bg-red-600 p-3 rounded-lg mb-4 text-center">
            <p className="font-semibold">{error}</p>
          </div>
        )}
        {message && (
          <div className="bg-blue-600 p-3 rounded-lg mb-4 text-center">
            <p className="font-semibold">{message}</p>
          </div>
        )}

        <div className="mb-6 bg-gray-700 p-4 rounded-lg">
          <h2 className="text-xl font-semibold mb-2">Your Profile</h2>
          <p className="text-sm text-gray-300 mb-2">Your User ID (share this for others to find you):</p>
          <div className="bg-gray-600 p-2 rounded-md text-sm break-all mb-3 shadow-inner border border-gray-500">
            {userId}
          </div>
          <label htmlFor="displayName" className="block text-sm font-medium text-gray-300 mb-1">
            Display Name:
          </label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={handleDisplayNameChange}
            className="w-full p-2 bg-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 border border-gray-500"
            placeholder="Enter your display name"
          />
        </div>

        {!currentCompetition ? (
          <div className="mt-8">
            <h2 className="text-xl sm:text-2xl font-semibold text-center mb-4 text-orange-300">
              Create or Join a Competition
            </h2>
            <div className="flex flex-col sm:flex-row gap-4 mb-4">
              <input
                type="text"
                value={competitionName}
                onChange={(e) => setCompetitionName(e.target.value)}
                className="flex-grow p-3 bg-gray-700 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 border border-gray-600 shadow-md"
                placeholder="Enter Competition Name or ID"
              />
              <button
                onClick={createCompetition}
                className="bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-6 rounded-lg shadow-lg transform transition duration-200 hover:scale-105 focus:outline-none focus:ring-2 focus:ring-green-400 focus:ring-offset-2 focus:ring-offset-gray-800"
              >
                Create New
              </button>
              <button
                onClick={joinCompetition}
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-lg shadow-lg transform transition duration-200 hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-gray-800"
              >
                Join Existing
              </button>
            </div>
            <p className="text-sm text-gray-400 text-center">
              To join, paste the Competition ID provided by the creator into the input field and click "Join Existing".
            </p>
          </div>
        ) : (
          <div className="mt-8 p-6 bg-gray-700 rounded-xl shadow-lg border border-gray-600">
            <h2 className="text-2xl sm:text-3xl font-bold text-center mb-4 text-orange-300">
              Competition: {currentCompetition.name}
            </h2>
            <p className="text-sm text-gray-300 text-center mb-4">
              Competition ID: <span className="font-mono bg-gray-600 p-1 rounded text-xs">{currentCompetition.id}</span>
            </p>

            <div className="mb-6">
              <h3 className="text-xl font-semibold mb-3 text-orange-200">Players ({currentCompetition.players?.length || 0})</h3>
              <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {currentCompetition.players && currentCompetition.players.map((pId: string, index: number) => (
                  <li key={pId} className="bg-gray-600 p-3 rounded-lg shadow-md text-sm flex items-center justify-between">
                    <span className="text-white">
                      {currentCompetition.playerNames?.[pId] || `Unknown Player (${pId.substring(0, 6)}...)`}
                    </span>
                    <div className="flex items-center space-x-2">
                        {pId === userId && <span className="px-2 py-1 bg-blue-500 text-white text-xs rounded-full">You</span>}
                        {currentCompetition.creatorId === pId && <span className="px-2 py-1 bg-yellow-500 text-gray-900 text-xs rounded-full">Creator</span>}
                        {currentCompetition.status === 'setup' && currentCompetition.creatorId === userId && (
                            <>
                                {index > 0 && (
                                    <button
                                        onClick={() => movePlayer(pId, 'up')}
                                        className="bg-gray-500 hover:bg-gray-400 text-white p-1 rounded-full text-xs"
                                        title="Move Up"
                                    >
                                        &#9650;
                                    </button>
                                )}
                                {index < currentCompetition.players.length - 1 && (
                                    <button
                                        onClick={() => movePlayer(pId, 'down')}
                                        className="bg-gray-500 hover:bg-gray-400 text-white p-1 rounded-full text-xs"
                                        title="Move Down"
                                    >
                                        &#9660;
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                  </li>
                ))}
              </ul>
              {currentCompetition.status === 'setup' && currentCompetition.creatorId === userId && (
                <div className="mt-4 text-center">
                  <button
                    onClick={shufflePlayers}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg shadow-md transform transition duration-200 hover:scale-105 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2 focus:ring-offset-gray-800"
                  >
                    Shuffle Player Order
                  </button>
                </div>
              )}
            </div>

            {currentCompetition.status === 'setup' && currentCompetition.creatorId === userId && (
              <div className="mt-6 text-center">
                <button
                  onClick={startDraft}
                  className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-6 rounded-lg shadow-lg transform transition duration-200 hover:scale-105 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:ring-offset-2 focus:ring-offset-gray-800"
                >
                  Start Draft
                </button>
              </div>
            )}

            {renderDraftStatus()}

            <div className="mt-8 p-6 bg-gray-800 rounded-xl shadow-lg border border-gray-700">
                <h3 className="text-2xl font-bold text-center mb-4 text-green-400">
                    DraftKings Fantasy Sports MMA Classic Scoring
                </h3>
                {Object.entries(DRAFTKINGS_SCORING).map(([category, rules]) => (
                    <div key={category} className="mb-4 last:mb-0">
                        <h4 className="text-xl font-semibold mb-2 text-green-300">{category}</h4>
                        <ul className="list-disc list-inside text-gray-300">
                            {Object.entries(rules).map(([rule, points]) => (
                                <li key={rule} className="mb-1">
                                    <span className="font-medium">{rule}:</span> {points}
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>

            <div className="mt-8 text-center text-sm text-gray-400">
                Scores will be calculated based on stats from UFCStats.com once the data is available.
            </div>

          </div>
        )}
      </div>
    </div>
  );
}

export default App;
