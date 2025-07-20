
'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import bcrypt from 'bcryptjs';
import { createSession, deleteSession, decrypt } from '@/lib/session';
import type { User, LoginHistoryEntry, LoginHistoryEntryWithUser, AuditLogEntry, Plan, BannedIp, SiteSettings } from '@/lib/types';
import { revalidatePath } from 'next/cache';
import { headers, cookies } from 'next/headers';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, writeBatch, setDoc, query, orderBy, limit, getDoc, where } from 'firebase/firestore';


// ================================================================= //
// Helper function to handle reading collections
// ================================================================= //
async function getCollection<T>(collectionName: string): Promise<T[]> {
  try {
    const collectionRef = collection(db, collectionName);
    const snapshot = await getDocs(collectionRef);
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => doc.data() as T);
  } catch (error) {
    console.error(`[Firestore Client Error] Failed to read collection '${collectionName}':`, error);
    return [];
  }
}

async function getCollectionWithQuery<T>(q: any): Promise<T[]> {
  try {
    const snapshot = await getDocs(q);
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => doc.data() as T);
  } catch (error) {
    console.error(`[Firestore Client Error] Failed to query collection:`, error);
    return [];
  }
}

async function readSiteSettings(): Promise<SiteSettings> {
  const defaultSettings: SiteSettings = {
    appName: 'NETRUNNER', logoUrl: '', webhookUrl: '', webhookUrlL4: '', webhookUrlL7: '', webhookUrlSms: '', backgroundImageUrl: '', backgroundOpacity: 0.4,
    successMessage: 'Attack command successfully sent to Discord bot.', discordServerId: '', recipientPhone: '', paidPlanPrice: 50,
    plusPlanPrice: 150, promptPayId: '', landingTagline: 'แพลตฟอร์มทดสอบความปลอดภัยเครือข่ายยุคใหม่ที่ขับเคลื่อนด้วย AI',
    landingSubTagline: 'ควบคุม, สั่งการ, และวิเคราะห์ ทั้งหมดในที่เดียว', isApiEnabled: false, maintenanceMode: false,
  };
  try {
    const docRef = doc(db, 'settings', 'site');
    const docSnapshot = await getDoc(docRef);
    return docSnapshot.exists() ? { ...defaultSettings, ...docSnapshot.data() } : defaultSettings;
  } catch (error) {
     console.error(`[Firestore Client Error] Failed to read site settings, returning default:`, error);
     return defaultSettings;
  }
}

// ================================================================= //
// DB functions that were in db.ts are now here
// ================================================================= //

async function readUsers(): Promise<User[]> {
  return getCollection<User>('users');
}

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

async function writeUsers(users: User[]): Promise<void> {
  try {
    const batch = writeBatch(db);
    const usersCollection = collection(db, 'users');
    users.forEach(user => {
      const docRef = doc(usersCollection, user.id);
      batch.set(docRef, user, { merge: true });
    });
    await batch.commit();
  } catch(error) {
    console.error(`[Firestore Client Error] Failed to write users:`, error);
  }
}

async function readLoginHistory(): Promise<LoginHistoryEntry[]> {
  const q = query(collection(db, 'login_history'), orderBy('timestamp', 'desc'), limit(500));
  return getCollectionWithQuery<LoginHistoryEntry>(q);
}

async function writeLoginHistory(history: LoginHistoryEntry[]): Promise<void> {
  try {
    const batch = writeBatch(db);
    const collectionRef = collection(db, 'login_history');
    history.forEach(entry => batch.set(doc(collectionRef, entry.id), entry));
    await batch.commit();
  } catch(error) {
    console.error(`[Firestore Client Error] Failed to write login history:`, error);
  }
}

async function readPlans(): Promise<Plan[]> {
  const plans = await getCollection<Plan>('plans');
  if (plans.length === 0) {
    return [
      { id: "free", name: "Free", price: 0, maxAttackTimeL4: 30, maxAttackTimeL7: 30, attacksPerHour: 10, apiRequestsPerHour: 0, defaultDurationDays: 9999, canCreateApiKeys: false },
      { id: "paid", name: "Paid", price: 50, salePrice: 39, maxAttackTimeL4: 300, maxAttackTimeL7: 120, attacksPerHour: 50, apiRequestsPerHour: 100, defaultDurationDays: 30, canCreateApiKeys: true },
      { id: "plus", name: "Plus", price: 150, maxAttackTimeL4: 300, maxAttackTimeL7: 300, attacksPerHour: 999, apiRequestsPerHour: 500, defaultDurationDays: 30, canCreateApiKeys: true }
    ];
  }
  return plans.map(p => ({ ...p, price: Number(p.price) || 0, salePrice: p.salePrice !== undefined ? Number(p.salePrice) : undefined }));
}

async function readAuditLog(): Promise<AuditLogEntry[]> {
  const q = query(collection(db, 'audit_log'), orderBy('timestamp', 'desc'), limit(500));
  return getCollectionWithQuery<AuditLogEntry>(q);
}

async function writeAuditLog(history: AuditLogEntry[]): Promise<void> {
  try {
    const batch = writeBatch(db);
    const collectionRef = collection(db, 'audit_log');
    history.forEach(entry => batch.set(doc(collectionRef, entry.id), entry));
    await batch.commit();
  } catch(error) {
    console.error(`[Firestore Client Error] Failed to write audit log:`, error);
  }
}

async function readBannedIps(): Promise<BannedIp[]> {
  return getCollection<BannedIp>('banned_ips');
}

// ================================================================= //
// Action logic starts here
// ================================================================= //

function getClientIp(): string {
    const headersList = headers();
    const forwardedFor = headersList.get('x-forwarded-for');
    if (forwardedFor) return forwardedFor.split(',')[0].trim();
    const realIp = headersList.get('x-real-ip');
    if (realIp) return realIp.trim();
    return '127.0.0.1';
}

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required.'),
  password: z.string().min(1, 'Password is required.'),
});

export async function login(_prevState: any, formData: FormData) {
  try {
    const result = loginSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!result.success) return { error: 'Invalid input.' };
    
    const { username, password } = result.data;
    const clientIp = getClientIp();

    const users = await readUsers();
    const user = users.find(u => u.username === username);

    if (!user || user.status === 'banned' || !user.password_hash) return { error: 'Invalid username or password.' };
    
    // Check maintenance mode BEFORE attempting login for non-admins
    const settings = await readSiteSettings();
    if (settings.maintenanceMode && user.role !== 'admin') {
      return { error: 'ระบบกำลังปิดปรับปรุง ขออภัยในความไม่สะดวก' };
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) return { error: 'Invalid username or password.' };

    try {
        const loginEntry: LoginHistoryEntry = { id: crypto.randomUUID(), userId: user.id, ip: clientIp, userAgent: headers().get('user-agent') || 'Unknown', timestamp: new Date().toISOString() };
        const history = await readLoginHistory();
        history.unshift(loginEntry);
        await writeLoginHistory(history.slice(0, 500));
    } catch (e) {
        console.error("Failed to write login history:", e);
    }

    await createSession(user);

  } catch (error: any) {
    console.error('Login Error:', error);
    return { error: error.message || 'An unexpected error occurred.' };
  }

  redirect('/dashboard');
}

const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters.'),
  password: z.string().min(6, 'Password must be at least 6 characters.'),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match.",
  path: ["confirmPassword"],
});


export async function register(_prevState: any, formData: FormData) {
    try {
        const settings = await readSiteSettings();
        if (settings.maintenanceMode) {
          return { error: 'ไม่สามารถลงทะเบียนได้ในขณะนี้เนื่องจากระบบกำลังปิดปรับปรุง' };
        }

        const result = registerSchema.safeParse(Object.fromEntries(formData.entries()));
        if (!result.success) {
            const errors = result.error.flatten().fieldErrors;
            const errorMessage = errors.username?.[0] || errors.password?.[0] || errors.confirmPassword?.[0] || 'Invalid input.';
            return { error: errorMessage };
        }

        const { username, password } = result.data;
        const clientIp = getClientIp();

        if ((await readBannedIps()).some(b => b.id === clientIp)) {
            return { error: 'ไม่สามารถลงทะเบียนได้เนื่องจาก IP ของคุณถูกแบน' };
        }
        
        const users = await readUsers();
        const plans = await readPlans();
        const freePlan = plans.find(p => p.id === 'free');

        if (!freePlan) throw new Error("Default 'free' plan not found in database. Cannot create new users.");
        if (users.find(u => u.username === username)) return { error: 'Username already exists.' };

        const newUser: User = { id: crypto.randomUUID(), username, password_hash: await bcrypt.hash(password, 10), role: 'user', plan: 'free', credits: 0, maxAttackTimeL4: freePlan.maxAttackTimeL4, maxAttackTimeL7: freePlan.maxAttackTimeL7, planAttacksPerHour: freePlan.attacksPerHour, apiRequestsPerHour: freePlan.apiRequestsPerHour || 0, status: 'active', registrationIp: clientIp };
        users.push(newUser);
        await writeUsers(users);
        
        try {
            const auditLogs = await readAuditLog();
            const auditEntry: AuditLogEntry = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), actorId: 'system', actorUsername: 'System (Register)', action: 'register', ip: clientIp, details: `New user '${username}' registered.`, targetId: newUser.id, targetUsername: newUser.username };
            await writeAuditLog([auditEntry, ...auditLogs].slice(0, 500));
        } catch (e) {
             console.error("Failed to write registration to audit log:", e);
        }
        
        try {
            const loginEntry: LoginHistoryEntry = { id: crypto.randomUUID(), userId: newUser.id, ip: clientIp, userAgent: headers().get('user-agent') || 'Unknown', timestamp: new Date().toISOString() };
            const history = await readLoginHistory();
            history.unshift(loginEntry);
            await writeLoginHistory(history.slice(0, 500));
        } catch (e) {
            console.error("Failed to write login history on registration:", e);
        }
        
        await createSession(newUser);
    } catch (error: any) {
        console.error('Registration Error:', error);
        return { error: error.message || 'An unexpected error occurred during registration.' };
    }
    redirect('/dashboard');
}


export async function logout() {
  await deleteSession();
  redirect('/login');
}

export async function clearSession() {
    await deleteSession();
    redirect('/login');
}

export async function getFullLoginHistory(): Promise<{history?: LoginHistoryEntryWithUser[], error?: string}> {
  const cookie = cookies().get('session');
  if (!cookie) return { error: 'Session not found' };
  const session = await decrypt(cookie.value);
  if (!session?.userId) return { error: 'Invalid session' };
  const user = await readUser(session.userId);
  if (!user || user.role !== 'admin') return { error: 'Unauthorized' };

  try {
    const allHistory = await readLoginHistory();
    const allUsers = await readUsers();
    const userMap = new Map(allUsers.map(u => [u.id, u.username]));
    const historyWithUsers: LoginHistoryEntryWithUser[] = allHistory.map(entry => ({ ...entry, username: userMap.get(entry.userId) || 'Unknown' }));
    return { history: historyWithUsers };
  } catch (error) {
    console.error("Failed to get full login history:", error);
    return { error: 'Could not load login history.' };
  }
}

export async function getLoginHistoryForUser(): Promise<{history?: LoginHistoryEntry[], error?: string}> {
    const cookie = cookies().get('session');
    if (!cookie) return { error: 'Session not found' };
    const session = await decrypt(cookie.value);
    if (!session?.userId) return { error: 'Invalid session' };
    const user = await readUser(session.userId);
    if (!user) return { error: 'Unauthorized' };
    try {
        const allHistory = await readLoginHistory();
        const userHistory = allHistory.filter(entry => entry.userId === user.id);
        return { history: userHistory };
    } catch (error) {
        console.error("Failed to get user login history:", error);
        return { error: 'Could not load login history.' };
    }
}

export async function getLoginHistoryForTargetUser(targetUserId: string): Promise<{history?: LoginHistoryEntry[], error?: string}> {
    const cookie = cookies().get('session');
    if (!cookie) return { error: 'Session not found' };
    const session = await decrypt(cookie.value);
    if (!session?.userId) return { error: 'Invalid session' };
    const sessionUser = await readUser(session.userId);
    if (!sessionUser || !['admin', 'moderator'].includes(sessionUser.role)) return { error: 'Unauthorized' };
    
    if (!(await readUser(targetUserId))) return { error: 'Target user not found.' };
    
    try {
        const allHistory = await readLoginHistory();
        return { history: allHistory.filter(entry => entry.userId === targetUserId) };
    } catch (error) {
        console.error(`Failed to get login history for target user ${targetUserId}:`, error);
        return { error: 'Could not load login history for the specified user.' };
    }
}
