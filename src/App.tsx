// src/App.tsx

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, type User } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, query, where, updateDoc, arrayUnion, Firestore } from 'firebase/firestore';

// Global variables provided by the Canvas environment
declare const __app_id: string | undefined;
declare const __firebase_config: string | undefined;
declare const __initial_auth_token: string | undefined;

// Define the base URL for your backend service
// IMPORTANT: During local development (running 'npm run dev' and 'python app.py' locally),
// this should be 'http://127.0.0.1:5000'.
// When you deploy your React app to a public host (Netlify/Vercel),
// you MUST update this URL to the public URL of your DEPLOYED Flask backend on Google Cloud Run.
// Example: const BACKEND_URL = 'https://your-ufc-backend-api-xxxxxx-uc.a.run.app';
const BACKEND_URL = 'http://127.0.0.1:5000'; // <--- REMEMBER TO REPLACE THIS URL BEFORE DEPLOYING TO NETLIFY!

// All 11 official UFC weight classes
const WEIGHT_CLASSES = [
  'Heavyweight', 'Light Heavyweight', 'Middleweight', 'Welterweight',
  'Lightweight', 'Featherweight', 'Bantamweight', 'Flyweight',
  'W.Bantamweight', 'W.Flyweight', 'W.Strawweight'
];

// DraftKings Scoring System (for display)
// (Removed unused DRAFTKINGS_SCORING to fix compile error)

export default function App() {}
  const [db, setDb] = useState<Firestore | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>('');
  const [competitionName, setCompetitionName] = useState<string>('');
  const [currentCompetition, setCurrentCompetition] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [allFighters, setAllFighters] = useState<any[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const [timeLeft, setTimeLeft] = useState<number>(180);
  const timerRef = useRef<number | null>(null);

  // Initialize Firebase and set up authentication
  useEffect(() => {
    let appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    let firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config as string) : null;
    if (!firebaseConfig) {
      setError('Firebase config not found.');
      setLoading(false);
      return;
    }
    const app = initializeApp(firebaseConfig);
    const firestoreDb = getFirestore(app);
    setDb(firestoreDb);
    const firebaseAuth = getAuth(app);

    const unsubscribe = onAuthStateChanged(firebaseAuth, async (user: User | null) => {
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
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(firebaseAuth, __initial_auth_token);
        } else {
          await signInAnonymously(firebaseAuth);
        }
      }
    });

    setLoading(false);
    return () => unsubscribe();
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
        setError(`Failed to load fighter data from backend: ${err.message}. Please ensure the Python backend is running.`);
      } finally {
        setLoading(false);
      }
    };
    fetchFighters();
  }, []);

  // Main render is moved to the end of the component to avoid unreachable code below.

  // Set up real-time listener for current competition
  useEffect(() => {
    if (!db || !userId) return;

    const appId: string = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    const competitionsRef = collection(db, 'artifacts', appId, 'public', 'data', 'competitions');
    const q = query(competitionsRef, where('players', 'array-contains', userId));

    const unsubscribe = onSnapshot(q, (snapshot: any) => {
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
    }, (err: any) => {
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

  // Handler for changing the user's display name
  const handleDisplayNameChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    setDisplayName(newName);
    if (db && userId) {
      const appId: string = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
      try {
        const userDocRef = doc(db, 'artifacts', appId, 'users', userId);
        await setDoc(userDocRef, { displayName: newName }, { merge: true });
        if (currentCompetition && currentCompetition.playerNames && userId) {
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

  // Function to create a new fantasy competition
  const createCompetition = async () => {
    if (!db || !userId || !competitionName.trim()) {
      setError("Please enter a competition name and ensure you are authenticated.");
      return;
    }
    setLoading(true);
    const appId: string = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
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

  // Function to join an existing fantasy competition
  const joinCompetition = async () => {
    if (!db || !userId || !competitionName.trim()) {
      setError("Please enter a competition ID and ensure you are authenticated.");
      return;
    }
    setLoading(true);
    const appId: string = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', competitionName.trim());
      const compSnap = await getDoc(competitionRef);
      if (compSnap.exists()) {
        const compData = compSnap.data();
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

  // Function to shuffle player order (creator only)
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
    const appId: string = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      const shuffledPlayers = [...currentCompetition.players].sort(() => Math.random() - 0.5);
      await updateDoc(competitionRef, { players: shuffledPlayers });
      setMessage("Player order shuffled!");
    } catch (err: any) {
      console.error("Error shuffling players:", err);
      setError(`Failed to shuffle players: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Function to handle a player making a draft pick
  const makePick = async (fighter: any) => {
    if (!db || !currentCompetition || currentCompetition.currentPickerId !== userId) {
      setError("It's not your turn to pick.");
      return;
    }

    const playerDraftedFighters = currentCompetition.draftedFighters?.[userId as string] || {};
    const weightClassPicksCount = Object.keys(playerDraftedFighters).filter(key => key !== 'Flex').length;
    const hasFlexPicked = !!playerDraftedFighters['Flex'];

    let assignedSlot: string | null = null;
    let pickedFighterData = { id: fighter.id, name: fighter.name, weightClass: fighter.weightClass, imageUrl: fighter.imageUrl, opponent: fighter.opponent, fightDate: fighter.fightDate };

    if (Object.values(playerDraftedFighters).some((f: any) => f.id === fighter.id)) {
      setError("You have already drafted this fighter.");
      return;
    }

    const isWeightClassSlotAvailable = !playerDraftedFighters[fighter.weightClass] && WEIGHT_CLASSES.includes(fighter.weightClass);

    if (isWeightClassSlotAvailable && weightClassPicksCount < WEIGHT_CLASSES.length) {
        assignedSlot = fighter.weightClass;
    } else if (!hasFlexPicked) {
        assignedSlot = 'Flex';
    } else {
        setError("You have already picked a fighter for this weight class or your Flex slot is full.");
        return;
    }

    if (!assignedSlot) {
      setError("Could not assign fighter to a slot. This shouldn't happen.");
      return;
    }

    // Check if fighter is already drafted by anyone
    const allDraftedFighterIds = Object.values(currentCompetition.draftedFighters || {})
      .flatMap((playerPicks: any) => Object.values(playerPicks))
      .map((f: any) => f.id);

    if (allDraftedFighterIds.includes(fighter.id)) {
      setError("This fighter has already been drafted by another player.");
      return;
    }

    setLoading(true);
    const appId: string = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    try {
      const competitionRef = doc(db, 'artifacts', appId, 'public', 'data', 'competitions', currentCompetition.id);
      const nextPickIndex = currentCompetition.currentPickIndex + 1;
      const nextPickerId = currentCompetition.draftOrder[nextPickIndex];
      const newStatus = nextPickIndex >= currentCompetition.draftOrder.length ? 'completed' : 'in_progress';

      const updatedDraftedFighters = {
        ...(currentCompetition.draftedFighters || {}),
        [userId as string]: {
          ...playerDraftedFighters,
          [assignedSlot]: pickedFighterData
        }
      };

      await updateDoc(competitionRef, {
        draftedFighters: updatedDraftedFighters,
        currentPickIndex: nextPickIndex,
        currentPickerId: nextPickerId || null,
        currentPickStartTime: newStatus === 'in_progress' ? Date.now() : null,
        status: newStatus,
      });

      setTimeLeft(180);
      setError(null);
      setMessage(`You drafted ${fighter.name} into your ${assignedSlot} slot!`);
    } catch (err: any) {
      console.error("Error making pick:", err);
      setError(`Failed to make pick: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };
  // Memoized function to get a list of undrafted fighters or all drafted fighter IDs
  const getUndraftedFighters = useCallback((returnDraftedIds: boolean = false) => {
    if (!currentCompetition || allFighters.length === 0) return [];

    const allDraftedFighterIds = Object.values(currentCompetition.draftedFighters || {})
      .flatMap((playerPicks: any) => Object.values(playerPicks))
      .map((f: any) => f.id);

    if (returnDraftedIds) return allDraftedFighterIds;

    // Return undrafted fighters
    return allFighters.filter((fighter: any) => !allDraftedFighterIds.includes(fighter.id));
  }, [currentCompetition, allFighters]);
  // Helper to get current picker name
  const currentPickerName =
    currentCompetition &&
    currentCompetition.currentPickerId &&
    currentCompetition.playerNames &&
    currentCompetition.playerNames[currentCompetition.currentPickerId]
      ? currentCompetition.playerNames[currentCompetition.currentPickerId]
      : 'Unknown';

  // Helper to get available picks for the current user
  const getMyAvailablePicks = () => {
    if (!currentCompetition || allFighters.length === 0) return [];
    const playerDraftedFighters = currentCompetition.draftedFighters?.[userId as string] || {};
    const pickedIds = Object.values(playerDraftedFighters).map((f: any) => f.id);
    // Only show undrafted fighters not already picked by this user
    const allDraftedFighterIds = Object.values(currentCompetition.draftedFighters || {})
      .flatMap((playerPicks: any) => Object.values(playerPicks))
      .map((f: any) => f.id);
    return allFighters.filter(
      (fighter: any) =>
        !allDraftedFighterIds.includes(fighter.id) && !pickedIds.includes(fighter.id)
    );
  };

  // Main render
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <span>Loading...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      {/* Display Name Input */}
      <div className="mb-4 flex flex-col items-center">
        <input
          type="text"
          placeholder="Enter Display Name"
          value={displayName}
          onChange={handleDisplayNameChange}
          className="mb-2 p-2 rounded bg-gray-700 text-white border border-gray-600"
        />
      </div>
      {/* Show error or message */}
      {error && <div className="mb-4 text-red-400 text-center">{error}</div>}
      {message && <div className="mb-4 text-green-400 text-center">{message}</div>}

      {/* Competition join/create */}
      <div className="mb-4 flex flex-col items-center">
        <input
          type="text"
          placeholder="Enter Competition Name or ID"
          value={competitionName}
          onChange={e => setCompetitionName(e.target.value)}
          className="mb-2 p-2 rounded bg-gray-700 text-white border border-gray-600"
        />
        <div className="flex space-x-2">
          <button
            className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
            onClick={joinCompetition}
            disabled={loading || !competitionName.trim()}
          >
            Join Competition
          </button>
          <button
            className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded"
            onClick={createCompetition}
            disabled={loading || !competitionName.trim()}
          >
            Create Competition
          </button>
        </div>
      </div>

      {/* Shuffle player order (creator only, setup phase) */}
      {currentCompetition && currentCompetition.creatorId === userId && currentCompetition.status === 'setup' && (
        <button
          className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded mb-4"
          onClick={shufflePlayers}
          disabled={loading}
        >
          Shuffle Player Order
        </button>
      )}

      {/* Draft UI */}
      {currentCompetition && (
        <div className="mt-6 p-4 bg-gray-800 rounded-lg shadow-inner border border-gray-700">
          <h3 className="text-2xl font-bold text-center text-orange-300 mb-4">
            Draft In Progress!
          </h3>
          <p className="text-lg text-center mb-2">
            <span className="font-semibold">{currentPickerName}</span> is currently picking.
            {currentCompetition.currentPickerId === userId && (
              <span className="ml-2 px-3 py-1 bg-blue-500 text-white rounded-full text-sm animate-pulse">YOUR TURN!</span>
            )}
          </p>
          {currentCompetition.currentPickerId === userId && (() => {
            const playerDraftedFighters = currentCompetition.draftedFighters?.[userId as string] || {};
            const pickedWeightClasses = Object.keys(playerDraftedFighters).filter((key: string) => key !== 'Flex');
            const missingWeightClasses = WEIGHT_CLASSES.filter((wc: string) => !pickedWeightClasses.includes(wc));
            const needsFlex = !playerDraftedFighters['Flex'];
            const weightClassPicksCount = pickedWeightClasses.length;
            let nextPickRequirement = '';
            if (weightClassPicksCount < WEIGHT_CLASSES.length) {
              nextPickRequirement = `Next: Pick a fighter for one of these weight classes: ${missingWeightClasses.join(', ')}`;
            } else if (needsFlex) {
              nextPickRequirement = `Next: Pick your Flex fighter (any weight class).`;
            } else {
              nextPickRequirement = `Waiting for other players to pick.`;
            }
            return (
              <p className="text-md text-center text-gray-300 mb-3">
                {nextPickRequirement}
              </p>
            );
          })()}

          <p className="text-3xl font-bold text-center text-purple-400 mb-4">
            Time left: {Math.floor(timeLeft / 60).toString().padStart(2, '0')}:{(timeLeft % 60).toString().padStart(2, '0')}
          </p>

          <div className="text-center mb-4">
            Pick #{currentCompetition.currentPickIndex + 1} of {currentCompetition.draftOrder.length}
          </div>

          <div className="mt-4">
            <h4 className="text-xl font-semibold mb-3 text-orange-200">
              {currentCompetition.currentPickerId === userId ? 'Available Fighters for Your Pick:' : 'All Remaining Undrafted Fighters:'}
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
              {(currentCompetition.currentPickerId === userId ? getMyAvailablePicks() : getUndraftedFighters())
                .filter((fighter: any) => fighter.name.toLowerCase().includes(searchQuery.toLowerCase()))
                .length > 0 ? (
                (currentCompetition.currentPickerId === userId ? getMyAvailablePicks() : getUndraftedFighters())
                  .filter((fighter: any) => fighter.name.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map((fighter: any) => (
                    <div
                      key={fighter.id}
                      className={`p-3 rounded-lg shadow-md flex flex-col items-start space-y-1 transition duration-200
                        ${currentCompetition.currentPickerId === userId ? 'bg-gray-600 cursor-pointer hover:bg-gray-500' : 'bg-gray-700 opacity-75 cursor-not-allowed'}`}
                      onClick={() => currentCompetition.currentPickerId === userId && makePick(fighter)}
                    >
                      <div className="flex items-center space-x-3 w-full">
                        <img src={fighter.imageUrl} alt={fighter.name || 'Fighter Image'} className="w-12 h-12 rounded-full object-cover border-2 border-gray-400" />
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
              {WEIGHT_CLASSES.map((wc: string) => (
                <div key={wc} className="bg-gray-600 p-3 rounded-lg shadow-md">
                  <p className="font-bold text-gray-200">{wc}:</p>
                  {currentCompetition.draftedFighters?.[userId as string]?.[wc] ? (
                    <div className="flex items-center space-x-2 mt-1">
                      <img src={currentCompetition.draftedFighters[userId as string][wc].imageUrl || `https://placehold.co/40x40/555/ffffff?text=${(currentCompetition.draftedFighters[userId as string][wc].name || '?').substring(0, 2)}`} alt={currentCompetition.draftedFighters[userId as string][wc].name || 'Fighter'} className="w-8 h-8 rounded-full object-cover border-2 border-gray-400" />
                      <span className="text-white">{currentCompetition.draftedFighters[userId as string][wc].name}</span>
                    </div>
                  ) : (
                    <span className="text-gray-400 italic">Unfilled</span>
                  )}
                </div>
              ))}
              <div className="bg-gray-600 p-3 rounded-lg shadow-md">
                <p className="font-bold text-gray-200">Flex:</p>
                {currentCompetition.draftedFighters?.[userId as string]?.['Flex'] ? (
                  <div className="flex items-center space-x-2 mt-1">
                    <img src={currentCompetition.draftedFighters[userId as string]['Flex'].imageUrl || `https://placehold.co/40x40/555/ffffff?text=${(currentCompetition.draftedFighters[userId as string]['Flex'].name || '?').substring(0, 2)}`} alt={currentCompetition.draftedFighters[userId as string]['Flex'].name || 'Flex Fighter'} className="w-8 h-8 rounded-full object-cover border-2 border-gray-400" />
                    <span className="text-white">{currentCompetition.draftedFighters[userId as string]['Flex'].name} <span className="text-sm text-gray-300">({currentCompetition.draftedFighters[userId as string]['Flex'].weightClass})</span></span>
                  </div>
                ) : (
                  <span className="text-gray-400 italic">Unfilled</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
