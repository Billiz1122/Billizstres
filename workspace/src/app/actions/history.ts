
'use server';

import type { AttackHistoryJobWithUser, User, AttackHistoryJob } from '@/lib/types';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, query, orderBy, limit, getDoc } from 'firebase/firestore';
import { getUserFromSession } from '@/lib/auth';


// DB Functions
async function readUser(userId: string): Promise<User | null> {
    try {
        const userDocRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userDocRef);
        return userDoc.exists() ? userDoc.data() as User : null;
    } catch (error) {
        console.error(`[Firestore Client Error] Failed to read user '${userId}':`, error);
        return null;
    }
}

async function readUsers(): Promise<User[]> {
  const snapshot = await getDocs(collection(db, 'users'));
  return snapshot.docs.map(doc => doc.data() as User);
}

async function readAttackHistory(): Promise<AttackHistoryJob[]> {
  const q = query(collection(db, 'attack_history'), orderBy('timestamp', 'desc'), limit(100));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => doc.data() as AttackHistoryJob);
}


// Action Logic
export async function getAttackHistory(fetchAsAdmin: boolean = false): Promise<{history?: AttackHistoryJobWithUser[], error?: string}> {
  const user = await getUserFromSession();
  if (!user) {
    return { error: 'Authentication required.' };
  }

  try {
    const allHistory = await readAttackHistory();
    const allUsers = await readUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.username]));

    const historyWithUsers: AttackHistoryJobWithUser[] = allHistory.map(entry => ({
      ...entry,
      username: userMap.get(entry.userId) || 'Unknown'
    }));
    
    const isViewingAsAdmin = ['admin', 'moderator'].includes(user.role) && fetchAsAdmin;
    
    if (!isViewingAsAdmin) {
       return { history: historyWithUsers.filter(entry => entry.userId === user.id) };
    }
        
    return { history: historyWithUsers };
  } catch (error) {
    console.error("Failed to get attack history:", error);
    return { error: 'Could not load attack history.' };
  }
}

export async function getAttackHistoryForUser(): Promise<{history?: AttackHistoryJobWithUser[], error?: string}> {
    const user = await getUserFromSession();
    if (!user) {
        return { error: 'Authentication required.' };
    }
    try {
        const allHistory = await readAttackHistory();
        const userHistory = allHistory
            .filter(entry => entry.userId === user.id)
            .map(entry => ({ ...entry, username: user.username }));
        return { history: userHistory };
    } catch (error) {
        console.error("Failed to get user attack history:", error);
        return { error: 'Could not load attack history.' };
    }
}
