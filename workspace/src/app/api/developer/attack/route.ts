
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { addAttacksToQueue } from '@/app/actions/attack';
import type { AttackInput, ApiKey, ApiRequestLog, SiteSettings, User, ClientAttackJob } from '@/lib/types';
import { ALLOWED_METHODS, ALLOWED_WEB_METHODS, ALLOWED_SMS_METHODS } from '@/config/attacks';
import { headers } from 'next/headers';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, writeBatch, setDoc, query, orderBy, limit, getDoc, where } from 'firebase/firestore';


// DB Functions needed for this route
async function readApiKey(key: string): Promise<ApiKey | null> {
    try {
        const q = query(collection(db, 'api_keys'), where('key', '==', key), limit(1));
        const snapshot = await getDocs(q);
        if (snapshot.empty) return null;
        return snapshot.docs[0].data() as ApiKey;
    } catch (error) {
        console.error(`[Firestore Client Error] Failed to read api key:`, error);
        return null;
    }
}

async function writeApiKey(apiKey: ApiKey): Promise<void> {
    try {
        await setDoc(doc(db, 'api_keys', apiKey.id), apiKey, { merge: true });
    } catch(error) {
        console.error(`[Firestore Client Error] Failed to write api key '${apiKey.id}':`, error);
    }
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
     return defaultSettings;
  }
}

async function writeApiRequestLog(log: ApiRequestLog): Promise<void> {
    try {
        await setDoc(doc(db, 'api_request_log', log.id), log);
    } catch(error) {
        console.error(`[Firestore Client Error] Failed to write api request log:`, error);
    }
}

// API Logic
const allMethods = [...ALLOWED_METHODS, ...ALLOWED_WEB_METHODS, ...ALLOWED_SMS_METHODS] as [string, ...string[]];
const apiAttackSchema = z.object({
  host: z.string().min(1, { message: "Host cannot be empty." }),
  port: z.coerce.number().min(1).max(65535),
  time: z.coerce.number().min(1),
  method: z.enum(allMethods),
});

function getClientIp(): string {
    const headersList = headers();
    const forwardedFor = headersList.get('x-forwarded-for');
    if (forwardedFor) return forwardedFor.split(',')[0].trim();
    const realIp = headersList.get('x-real-ip');
    if (realIp) return realIp.trim();
    return '127.0.0.1';
}

async function logApiRequest(apiKey: ApiKey, requestData: any, result: { success: boolean; message: string; }): Promise<void> {
    try {
        const logEntry: ApiRequestLog = {
            id: crypto.randomUUID(), apiKeyId: apiKey.id, userId: apiKey.userId, username: apiKey.username,
            timestamp: new Date().toISOString(), ip: getClientIp(), userAgent: headers().get('user-agent') || 'Unknown',
            method: requestData.method || 'N/A', target: requestData.host || 'N/A',
            status: result.success ? 'success' : 'error', responseMessage: result.message,
        };
        await writeApiRequestLog(logEntry);
    } catch(e) {
        console.error("Failed to write to API request log:", e);
    }
}

export async function POST(request: Request) {
  let apiKeyData: ApiKey | null = null;
  let requestBody: any = {};
  
  try {
    const settings = await readSiteSettings();
    if (!settings.isApiEnabled) {
      return NextResponse.json({ success: false, error: 'API is currently disabled by the administrator.' }, { status: 503 });
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ success: false, error: 'Unauthorized: Missing or invalid API key.' }, { status: 401 });
    }
    const keyString = authHeader.split(' ')[1];

    apiKeyData = await readApiKey(keyString);
    if (!apiKeyData || !apiKeyData.isEnabled) {
      return NextResponse.json({ success: false, error: 'Unauthorized: Invalid or disabled API key.' }, { status: 401 });
    }

    const user = await readUser(apiKeyData.userId);
    if (!user || user.status !== 'active') {
      return NextResponse.json({ success: false, error: 'Unauthorized: User account is inactive or banned.' }, { status: 403 });
    }
    
    const now = new Date();
    if (now.getTime() - new Date(apiKeyData.lastHourTimestamp).getTime() > 3600000) {
        apiKeyData.requestsLastHour = 0;
        apiKeyData.lastHourTimestamp = now.toISOString();
    }

    if (apiKeyData.requestsLastHour >= user.apiRequestsPerHour) {
        const errorResult = { success: false, message: `API rate limit exceeded. You can make ${user.apiRequestsPerHour} requests per hour.` };
        await logApiRequest(apiKeyData, requestBody, errorResult); 
        return NextResponse.json({ success: false, error: errorResult.message }, { status: 429 });
    }
    
    apiKeyData.requestsLastHour++;
    apiKeyData.lastUsedAt = now.toISOString();
    apiKeyData.totalRequests++;
    await writeApiKey(apiKeyData);

    requestBody = await request.json();
    const result = apiAttackSchema.safeParse(requestBody);

    if (!result.success) {
      const error = Object.values(result.error.flatten().fieldErrors)[0]?.[0] || 'Invalid input.';
      const errorResult = { success: false, message: error };
      await logApiRequest(apiKeyData, requestBody, errorResult);
      return NextResponse.json({ success: false, error: error }, { status: 400 });
    }
    
    let { host, port, time, method } = result.data;
    if (ALLOWED_WEB_METHODS.includes(method) || ALLOWED_SMS_METHODS.includes(method)) {
        port = 80;
    }

    const attackResult = await addAttacksToQueue([{ host, port, time, method }], user);
    const logMessage = { success: attackResult.success, message: attackResult.message || attackResult.error || 'Unknown outcome' };
    await logApiRequest(apiKeyData, result.data, logMessage);

    if (attackResult.success) {
        return NextResponse.json({ success: true, message: attackResult.message || 'Attack job(s) added to the queue.' });
    } else {
        return NextResponse.json({ success: false, error: attackResult.error || 'Failed to queue attack.' }, { status: 500 });
    }

  } catch (error: any) {
    console.error('[API /developer/attack Error]', error);
    if (error instanceof SyntaxError) {
        return NextResponse.json({ success: false, error: 'Invalid JSON in request body.' }, { status: 400 });
    }
    const errorResult = { success: false, message: 'An internal server error occurred.' };
    if (apiKeyData) {
        await logApiRequest(apiKeyData, requestBody, errorResult);
    }
    return NextResponse.json({ success: false, error: errorResult.message }, { status: 500 });
  }
}
