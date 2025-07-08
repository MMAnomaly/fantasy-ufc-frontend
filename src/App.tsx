// src/App.tsx

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, query, where, updateDoc, arrayUnion } from 'firebase/firestore';
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import type { Auth, User } from 'firebase/auth';
import type { Firestore, QuerySnapshot } from 'firebase/firestore';

// Global variables provided by the Canvas environment
declare const __app_id: string;
declare const __firebase_config: string;
declare const __initial_auth_token: string | undefined;

// Define the base URL for the backend service
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'https://ufc-backend-api-1038505217453.us-central1.run.app/';

// All 11 official UFC weight classes
const WEIGHT_CLASSES = [
  'Heavyweight', 'Light Heavyweight', 'Middleweight', 'Welterweight',
  'Lightweight', 'Featherweight', 'Bantamweight', 'Flyweight',
  'W.Bantamweight', 'W.Flyweight', 'W.Strawweight'
] as const;

// Interfaces for data structures
interface Fighter {
  id: string;
  name: string;
  weightClass: typeof WEIGHT_CLASSES[number];
  imageUrl: string;
  opponent?: string;
  fightDate?: string;
  hasScheduledBout?: boolean;
}

interface Competition {
  id: string;
  name: string;
  players: string[];
  playerNames: { [userId: string]: string };
  status: 'setup' | 'in_progress' | 'completed';
  createdAt: number;
  draftOrder: string[];
  currentPickIndex: number;
  currentPickerId: string | null;
  currentPickStartTime: number | null;
  draftedFighters: { [userId: string]: { [slot: string]: Fighter } };
  scores: { [userId: string]: number };
  creatorId: string;
}

const App: React.FC = () => {
  const [db, setDb] = useState<Firestore | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>('');
  const [competitionName, setCompetitionName] = useState<string>('');
  const [currentCompetition, setCurrentCompetition] = useState<Competition | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [allFighters, setAllFighters] = useState<Fighter[]>([]);

  const [timeLeft, setTimeLeft] = useState<number>(180);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Log state changes for debugging
  useEffect(() => {
    console.log('State:', { userId, currentCompetition, allFighters, loading, error, message });
  }, [userId, currentCompetition, allFighters, loading, error, message]);

  // Initialize Firebase and set up authentication
  useEffect(() => {
    try {
      console.log('__app_id:', __app_id);
      console.log('__firebase_config:', JSON.parse(__firebase_config));
      const firebaseConfig: FirebaseOptions = JSON.parse(__firebase_config);
      const firebaseApp = initializeApp(firebaseConfig);
      const firestoreDb = getFirestore(firebaseApp);
      const firebaseAuth = getAuth(firebaseApp);

      setDb(firestoreDb);

      const unsubscribe = onAuthStateChanged(firebaseAuth, async (user: User | null) => {
        console.log('Auth state:', user ? user.uid : 'No user');
        if (user) {
          setUserId(user.uid);
          const userDocRef = doc(firestoreDb, 'artifacts', __app_id, 'users', user.uid);
          const userDocSnap = await getDoc(userDocRef);
          if (userDocSnap.exists()) {
            setDisplayName(userDocSnap.data().displayName || `User_${user.uid.substring(0, 6)}`);
          } else {
            const defaultName = `User_${user.uid.substring(0, 6)}`;
            await setDoc(userDocRef, { displayName: defaultName }, { merge: true });
            setDisplayName(defaultName);
          }
        } else {
          if (__initial_auth_token) {
            await signInWithCustomToken(firebaseAuth, __initial_auth_token);
          } else {
            await signInAnonymously(firebaseAuth);
          }
        }
        setLoading(false);
      });

      return () => unsubscribe();
    } catch (err: unknown) {
      console.error('Firebase init error:', err);
      setError(`Failed to initialize Firebase: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
        const data: Fighter[] = await response.json();
        console.log('Fetched fighters:', data);
        setAllFighters(data);
        setError(null);
      } catch (err: unknown) {
        console.error('Failed to fetch fighters:', err);
        setError(`Failed to load fighter data from backend: ${err instanceof Error ? err.message : 'Unknown error'}. Please ensure the Python backend is running.`);
      } finally {
        setLoading(false);
      }
    };
    fetchFighters();
  }, []);

  // Set up real-time listener for current competition
  useEffect(() => {
    if (!db || !userId) return;

    const competitionsRef = collection(db, 'artifacts', __app_id, 'public', 'data', 'competitions');
    const q = query(competitionsRef, where('players', 'array-contains', userId));

    const unsubscribe = onSnapshot(q, (snapshot: QuerySnapshot) => {
      console.log('Competitions snapshot:', snapshot.docs.length);
      if (!snapshot.empty) {
        const compDoc = snapshot.docs[0];
        const compData = { id: compDoc.id, ...compDoc.data() } as Competition;
        console.log('Current competition:', compData);
        setCurrentCompetition(compData);
        if (compData.status === 'in_progress' && compData.currentPickStartTime) {
          const elapsed = Math.floor((Date.now() - compData.currentPickStartTime) / 1000);
          const remaining = Math.max(0, 180 - elapsed);
          setTimeLeft(remaining);
        }
      } else {
        setCurrentCompetition(null);
      }
    }, (err: unknown) => {
      console.error('Error listening to competitions:', err);
      setError(`Failed to load competitions: ${err instanceof Error ? err.message : 'Unknown error'}`);
    });

    return () => unsubscribe();
  }, [db, userId]);

  // Draft timer effect
  useEffect(() => {
    if (currentCompetition?.status === 'in_progress' && currentCompetition?.currentPickerId === userId) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      timerRef.current = setInterval(() => {
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
  const handleDisplayNameChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const newName = e.target.value;
    setDisplayName(newName);
    if (db && userId) {
      try {
        const userDocRef = doc(db, 'artifacts', __app_id, 'users', userId);
        await setDoc(userDocRef, { displayName: newName }, { merge: true });
        if (currentCompetition && currentCompetition.playerNames) {
          const competitionRef = doc(db, 'artifacts', __app_id, 'public', 'data', 'competitions', currentCompetition.id);
          await updateDoc(competitionRef, {
            [`playerNames.${userId}`]: newName,
          });
        }
      } catch (err: unknown) {
        console.error('Error updating display name:', err);
        setError(`Failed to update display name: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
  };

  // Function to create a new fantasy competition
  const createCompetition = async (): Promise<void> => {
    if (!db || !userId || !competitionName.trim()) {
      setError('Please enter a competition name and ensure you are authenticated.');
      return;
    }
    setLoading(true);
    try {
      const competitionsRef = collection(db, 'artifacts', __app_id, 'public', 'data', 'competitions');
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
        creatorId: userId,
      });
      setCompetitionName('');
      setError(null);
      setMessage(`Competition "${competitionName.trim()}" created! Share the Competition ID above to invite others.`);
    } catch (err: unknown) {
      console.error('Error creating competition:', err);
      setError(`Failed to create competition: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  // Function to join an existing fantasy competition
  const joinCompetition = async (): Promise<void> => {
    if (!db || !userId || !competitionName.trim()) {
      setError('Please enter a competition ID and ensure you are authenticated.');
      return;
    }
    setLoading(true);
    try {
      const competitionRef = doc(db, 'artifacts', __app_id, 'public', 'data', 'competitions', competitionName.trim());
      const compDocSnap = await getDoc(competitionRef);

      if (compDocSnap.exists()) {
        const compData = compDocSnap.data() as Competition;
        if (compData.status !== 'setup') {
          setError('Cannot join: Draft has already started or completed for this competition.');
          setLoading(false);
          return;
        }
        if (!compData.players.includes(userId)) {
          await updateDoc(competitionRef, {
            players: arrayUnion(userId),
            [`playerNames.${userId}`]: displayName,
          });
          setMessage(`Successfully joined competition "${compData.name}"!`);
        } else {
          setMessage(`You are already in competition "${compData.name}".`);
        }
        setCompetitionName('');
        setError(null);
      } else {
        setError('Competition not found. Please check the ID.');
      }
    } catch (err: unknown) {
      console.error('Error joining competition:', err);
      setError(`Failed to join competition: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  // Helper function to generate snake draft order
  const generateSnakeDraftOrder = useCallback((players: string[], rounds: number): string[] => {
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

  // Function to shuffle player order (only for creator in setup phase)
  const shufflePlayers = async (): Promise<void> => {
    if (!db || !currentCompetition || currentCompetition.creatorId !== userId) {
      setError('Only the competition creator can shuffle players.');
      return;
    }
    if (currentCompetition.status !== 'setup') {
      setError('Cannot shuffle players: Draft has already started.');
      return;
    }

    setLoading(true);
    try {
      const competitionRef = doc(db, 'artifacts', __app_id, 'public', 'data', 'competitions', currentCompetition.id);
      const shuffledPlayers = [...currentCompetition.players].sort(() => Math.random() - 0.5);
      await updateDoc(competitionRef, { players: shuffledPlayers });
      setMessage('Player order shuffled!');
      setError(null);
    } catch (err: unknown) {
      console.error('Error shuffling players:', err);
      setError(`Failed to shuffle players: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  // Function to start the fantasy draft
  const startDraft = async (): Promise<void> => {
    if (!db || !currentCompetition || currentCompetition.creatorId !== userId) {
      setError('Only the competition creator can start the draft.');
      return;
    }
    if (currentCompetition.status !== 'setup') {
      setError('Draft has already started or completed.');
      return;
    }
    if (currentCompetition.players.length === 0) {
      setError('Cannot start draft: No players in the competition.');
      return;
    }

    setLoading(true);
    try {
      const competitionRef = doc(db, 'artifacts', __app_id, 'public', 'data', 'competitions', currentCompetition.id);
      const roundsPerPlayer = WEIGHT_CLASSES.length + 1;
      const draftOrder = generateSnakeDraftOrder(currentCompetition.players, roundsPerPlayer);

      const initialDraftedFighters: { [key: string]: { [key: string]: Fighter } } = {};
      currentCompetition.players.forEach((pId: string) => {
        initialDraftedFighters[pId] = {};
      });

      await updateDoc(competitionRef, {
        status: 'in_progress',
        draftOrder,
        currentPickIndex: 0,
        currentPickerId: draftOrder[0],
        currentPickStartTime: Date.now(),
        draftedFighters: initialDraftedFighters,
      });
      setError(null);
      setMessage('Draft has started!');
    } catch (err: unknown) {
      console.error('Error starting draft:', err);
      setError(`Failed to start draft: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  // Function to handle a player making a draft pick
  const makePick = async (fighter: Fighter): Promise<void> => {
    if (!db || !currentCompetition || currentCompetition.currentPickerId !== userId || !userId) {
      setError("It's not your turn to pick.");
      return;
    }
    if (currentCompetition.status !== 'in_progress') {
      setError('Draft is not in progress.');
      return;
    }

    const playerDraftedFighters = currentCompetition.draftedFighters[userId] || {};
    const hasFlexPicked = !!playerDraftedFighters['Flex'];
    const weightClassPicksCount = Object.keys(playerDraftedFighters).filter((key) => key !== 'Flex').length;

    let assignedSlot: string | null = null;
    const pickedFighterData: Fighter = {
      id: fighter.id,
      name: fighter.name,
      weightClass: fighter.weightClass,
      imageUrl: fighter.imageUrl,
      opponent: fighter.opponent,
      fightDate: fighter.fightDate,
      hasScheduledBout: fighter.hasScheduledBout,
    };

    if (Object.values(playerDraftedFighters).some((f: Fighter) => f.id === fighter.id)) {
      setError('You have already drafted this fighter.');
      return;
    }

    const isWeightClassSlotAvailable = !playerDraftedFighters[fighter.weightClass] && WEIGHT_CLASSES.includes(fighter.weightClass);

    if (isWeightClassSlotAvailable && weightClassPicksCount < WEIGHT_CLASSES.length) {
      assignedSlot = fighter.weightClass;
    } else if (!hasFlexPicked) {
      assignedSlot = 'Flex';
    } else {
      setError('You have already picked a fighter for this weight class or your Flex slot is full.');
      return;
    }

    if (!assignedSlot) {
      setError("Could not assign fighter to a slot. This shouldn't happen.");
      return;
    }

    const allDraftedFighterIds = getUndraftedFighters(true) as string[];
    if (allDraftedFighterIds.includes(fighter.id)) {
      setError('This fighter has already been drafted by another player.');
      return;
    }

    setLoading(true);
    try {
      const competitionRef = doc(db, 'artifacts', __app_id, 'public', 'data', 'competitions', currentCompetition.id);
      const nextPickIndex = currentCompetition.currentPickIndex + 1;
      const nextPickerId = currentCompetition.draftOrder[nextPickIndex];
      const newStatus = nextPickIndex >= currentCompetition.draftOrder.length ? 'completed' : 'in_progress';

      const updatedDraftedFighters = {
        ...currentCompetition.draftedFighters,
        [userId]: {
          ...playerDraftedFighters,
          [assignedSlot]: pickedFighterData,
        },
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
    } catch (err: unknown) {
      console.error('Error making pick:', err);
      setError(`Failed to make pick: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  // Memoized function to get a list of undrafted fighters or all drafted fighter IDs
  const getUndraftedFighters = useCallback(
    (returnDraftedIds: boolean = false): Fighter[] | string[] => {
      if (!currentCompetition || allFighters.length === 0) return [];

      const allDraftedFighterIds = Object.values(currentCompetition.draftedFighters)
        .flatMap((playerPicks) => Object.values(playerPicks))
        .map((f: Fighter) => f.id);

      if (returnDraftedIds) {
        return allDraftedFighterIds;
      }
      return allFighters.filter((fighter) => !allDraftedFighterIds.includes(fighter.id));
    },
    [currentCompetition, allFighters]
  );

  const getMyAvailablePicks = useCallback((): Fighter[] => {
    if (!currentCompetition || !userId || currentCompetition.currentPickerId !== userId || allFighters.length === 0) {
      return [];
    }

    const playerDraftedFighters = currentCompetition.draftedFighters[userId] || {};
    const playerPickedWeightClasses = Object.keys(playerDraftedFighters).filter((key) => key !== 'Flex');

    const availableSpecificSlots = WEIGHT_CLASSES.filter((wc) => !playerPickedWeightClasses.includes(wc));
    const flexSlotOpen = !playerDraftedFighters['Flex'];
    const weightClassPicksCount = Object.keys(playerDraftedFighters).filter((key) => key !== 'Flex').length;
    const requiredSpecificPicksRemaining = WEIGHT_CLASSES.length - weightClassPicksCount;

    const undraftedFighters = getUndraftedFighters() as Fighter[];

    return undraftedFighters.filter((fighter) => {
      if (availableSpecificSlots.includes(fighter.weightClass) && !playerDraftedFighters[fighter.weightClass]) {
        return true;
      }
      if (flexSlotOpen && (requiredSpecificPicksRemaining === 0 || !availableSpecificSlots.includes(fighter.weightClass))) {
        return true;
      }
      return false;
    });
  }, [currentCompetition, userId, allFighters, getUndraftedFighters]);

  const renderDraftStatus = (): JSX.Element | null => {
    if (!currentCompetition || !userId) return null;

    if (currentCompetition.status === 'completed') {
      return <p className="text-xl text-green-400 font-bold text-center mt-4">Draft Completed!</p>;
    }

    if (currentCompetition.status === 'in_progress') {
      const currentPickerName = currentCompetition.playerNames[currentCompetition.currentPickerId!] || 'Unknown Player';
      const isMyTurn = currentCompetition.currentPickerId === userId;
      const minutes = Math.floor(timeLeft / 60);
      const seconds = timeLeft % 60;

      const playerDraftedFighters = currentCompetition.draftedFighters[userId] || {};
      const pickedWeightClasses = Object.keys(playerDraftedFighters).filter((key) => key !== 'Flex');
      const missingWeightClasses = WEIGHT_CLASSES.filter((wc) => !pickedWeightClasses.includes(wc));
      const needsFlex = !playerDraftedFighters['Flex'];
      const weightClassPicksCount = Object.keys(playerDraftedFighters).filter((key) => key !== 'Flex').length;

      let nextPickRequirement = '';
      if (weightClassPicksCount < WEIGHT_CLASSES.length) {
        nextPickRequirement = `Next: Pick a fighter for one of these weight classes: ${missingWeightClasses.join(', ')}`;
      } else if (needsFlex) {
        nextPickRequirement = `Next: Pick your Flex fighter (any weight class).`;
      } else {
        nextPickRequirement = `Waiting for other players to pick.`;
      }

      const fightersToDisplay = isMyTurn ? getMyAvailablePicks() : (getUndraftedFighters() as Fighter[]);
      const filteredFighters = fightersToDisplay.filter((fighter) =>
        fighter.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      return (
        <div className="mt-6 p-4 bg-gray-800 rounded-lg shadow-inner border border-gray-700">
          <h3 className="text-2xl font-bold text-center text-orange-300 mb-4">Draft In Progress!</h3>
          <p className="text-lg text-center mb-2">
            <span className="font-semibold">{currentPickerName}</span> is currently picking.
            {isMyTurn && <span className="ml-2 px-3 py-1 bg-blue-500 text-white rounded-full text-sm animate-pulse">YOUR TURN!</span>}
          </p>
          {isMyTurn && <p className="text-md text-center text-gray-300 mb-3">{nextPickRequirement}</p>}

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
                filteredFighters.map((fighter) => (
                  <div
                    key={fighter.id}
                    className={`p-3 rounded-lg shadow-md flex flex-col items-start space-y-1 transition duration-200
                      ${isMyTurn ? 'bg-gray-600 cursor-pointer hover:bg-gray-500' : 'bg-gray-700 opacity-75 cursor-not-allowed'}`}
                    onClick={() => isMyTurn && makePick(fighter)}
                  >
                    <div className="flex items-center space-x-3 w-full">
                      <img
                        src={fighter.imageUrl}
                        alt={fighter.name}
                        className="w-12 h-12 rounded-full object-cover border-2 border-gray-400"
                      />
                      <div>
                        <p className="font-semibold text-lg text-white">{fighter.name}</p>
                        <p className="text-sm text-gray-200">{fighter.weightClass}</p>
                      </div>
                    </div>
                    {fighter.hasScheduledBout && fighter.opponent && fighter.fightDate && (
                      <div className="text-xs text-gray-300 pl-16 -mt-2">
                        <p>vs. {fighter.opponent}</p>
                        <p>
                          on{' '}
                          {new Date(fighter.fightDate).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                          })}
                        </p>
                      </div>
                    )}
                    {!fighter.hasScheduledBout && <p className="text-xs text-gray-300 pl-16 -mt-2">No Scheduled Bout</p>}
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
              {WEIGHT_CLASSES.map((wc) => (
                <div key={wc} className="bg-gray-600 p-3 rounded-lg shadow-md">
                  <p className="font-bold text-gray-200">{wc}:</p>
                  {currentCompetition.draftedFighters[userId]?.[wc] ? (
                    <div className="flex items-center space-x-2 mt-1">
                      <img
                        src={
                          currentCompetition.draftedFighters[userId][wc].imageUrl ||
                          `https://placehold.co/40x40/555/ffffff?text=${currentCompetition.draftedFighters[userId][wc].name.substring(0, 2)}`
                        }
                        alt={currentCompetition.draftedFighters[userId][wc].name}
                        className="w-8 h-8 rounded-full object-cover border-2 border-gray-400"
                      />
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
                    <img
                      src={
                        currentCompetition.draftedFighters[userId]['Flex'].imageUrl ||
                        `https://placehold.co/40x40/555/ffffff?text=${currentCompetition.draftedFighters[userId]['Flex'].name.substring(0, 2)}`
                      }
                      alt={currentCompetition.draftedFighters[userId]['Flex'].name}
                      className="w-8 h-8 rounded-full object-cover border-2 border-gray-400"
                    />
                    <span className="text-white">
                      {currentCompetition.draftedFighters[userId]['Flex'].name}{' '}
                      <span className="text-sm text-gray-300">
                        ({currentCompetition.draftedFighters[userId]['Flex'].weightClass})
                      </span>
                    </span>
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

  return (
    <div className="container mx-auto p-4">
      {loading && <p className="text-center text-gray-400">Loading...</p>}
      {error && <p className="text-center text-red-400">{error}</p>}
      {message && <p className="text-center text-green-400">{message}</p>}
      {!loading && !error && !userId && <p className="text-center text-gray-400">Authenticating...</p>}
      {!loading && !error && userId && !currentCompetition && (
        <p className="text-center text-gray-400">No active competition. Create or join one below.</p>
      )}
      <div className="mb-4">
        <label className="block text-gray-200">Display Name:</label>
        <input
          type="text"
          value={displayName}
          onChange={handleDisplayNameChange}
          className="w-full p-2 bg-gray-700 rounded-md text-white border border-gray-600"
        />
      </div>
      <div className="mb-4">
        <label className="block text-gray-200">Competition Name/ID:</label>
        <input
          type="text"
          value={competitionName}
          onChange={(e) => setCompetitionName(e.target.value)}
          className="w-full p-2 bg-gray-700 rounded-md text-white border border-gray-600"
        />
      </div>
      <div className="flex space-x-4">
        <button
          onClick={createCompetition}
          className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
          disabled={loading}
        >
          Create Competition
        </button>
        <button
          onClick={joinCompetition}
          className="px-4 py-2 bg-green-500 text-white rounded-md hover:bg-green-600"
          disabled={loading}
        >
          Join Competition
        </button>
        {currentCompetition && userId && currentCompetition.creatorId === userId && currentCompetition.status === 'setup' && (
          <>
            <button
              onClick={shufflePlayers}
              className="px-4 py-2 bg-yellow-500 text-white rounded-md hover:bg-yellow-600"
              disabled={loading}
            >
              Shuffle Players
            </button>
            <button
              onClick={startDraft}
              className="px-4 py-2 bg-purple-500 text-white rounded-md hover:bg-purple-600"
              disabled={loading}
            >
              Start Draft
            </button>
          </>
        )}
      </div>
      {currentCompetition && userId && renderDraftStatus()}
    </div>
  );
};

export default App;