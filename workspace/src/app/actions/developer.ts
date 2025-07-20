
'use server';

import { z } from 'zod';
import { createApiKey, deleteUserApiKey as deleteUserApiKeyAction, getApiKeysForAdmin as getApiKeysForAdminAction, manageApiKey as manageApiKeyAction, getApiRequestLog as getApiRequestLogAction } from '@/lib/developer';
import type { User, ApiKey, Plan, ApiRequestLog } from '@/lib/types';
import crypto from 'crypto';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, setDoc, deleteDoc, query, getDoc } from 'firebase/firestore';
import { getUserFromSession } from '@/lib/auth';


// ================================================================= //
// DB functions that were in db.ts are now here
// ================================================================= //

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

async function readPlans(): Promise<Plan[]> {
  const snapshot = await getDocs(collection(db, 'plans'));
  if (snapshot.empty) {
    return [
      { id: "free", name: "Free", price: 0, maxAttackTimeL4: 30, maxAttackTimeL7: 30, attacksPerHour: 10, apiRequestsPerHour: 0, defaultDurationDays: 9999, canCreateApiKeys: false },
      { id: "paid", name: "Paid", price: 50, salePrice: 39, maxAttackTimeL4: 300, maxAttackTimeL7: 120, attacksPerHour: 50, apiRequestsPerHour: 100, defaultDurationDays: 30, canCreateApiKeys: true },
      { id: "plus", name: "Plus", price: 150, maxAttackTimeL4: 300, maxAttackTimeL7: 300, attacksPerHour: 999, apiRequestsPerHour: 500, defaultDurationDays: 30, canCreateApiKeys: true }
    ];
  }
  return snapshot.docs.map(doc => {
      const p = doc.data() as Plan;
      return { ...p, price: Number(p.price) || 0, salePrice: p.salePrice !== undefined ? Number(p.salePrice) : undefined };
  });
}

async function readApiKeys(): Promise<ApiKey[]> {
    const snapshot = await getDocs(collection(db, 'api_keys'));
    return snapshot.docs.map(doc => doc.data() as ApiKey);
}

async function writeApiKey(apiKey: ApiKey): Promise<void> {
    try {
        await setDoc(doc(db, 'api_keys', apiKey.id), apiKey, { merge: true });
    } catch(error) {
        console.error(`[Firestore Client Error] Failed to write API key '${apiKey.id}':`, error);
    }
}

async function deleteApiKey(apiKeyId: string): Promise<void> {
    try {
        await deleteDoc(doc(db, 'api_keys', apiKeyId));
    } catch (error) {
        console.error(`[Firestore Client Error] Failed to delete API key '${apiKeyId}':`, error);
    }
}

async function readApiRequestLog(): Promise<ApiRequestLog[]> {
    const q = query(collection(db, 'api_request_log'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data() as ApiRequestLog).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ================================================================= //
// Action logic starts here
// ================================================================= //

export async function createApiKey(): Promise<{ success: boolean; error?: string; apiKey?: ApiKey }> {
    const user = await getUserFromSession();
    if (!user) {
        return { success: false, error: 'Authentication required.' };
    }
    
    const plans = await readPlans();
    const userPlan = plans.find(p => p.id === user.plan);
    
    if (!userPlan || !userPlan.canCreateApiKeys) {
        return { success: false, error: 'แผนปัจจุบันของคุณไม่สามารถสร้าง API Key ได้' };
    }
    
    // Limit to 1 API key per user for simplicity
    const existingKeys = (await readApiKeys()).filter(k => k.userId === user.id);
    if (existingKeys.length >= 1) {
        return { success: false, error: 'คุณสามารถสร้าง API Key ได้เพียง 1 อันเท่านั้น' };
    }

    try {
        const key = `netrunner_${crypto.randomBytes(24).toString('hex')}`;
        const newApiKey: ApiKey = {
            id: crypto.randomUUID(),
            userId: user.id,
            username: user.username,
            planId: user.plan,
            key: key,
            createdAt: new Date().toISOString(),
            totalRequests: 0,
            requestsLastHour: 0,
            lastHourTimestamp: new Date(0).toISOString(), // Set to epoch initially
            isEnabled: true,
        };

        await writeApiKey(newApiKey);
        
        return { success: true, apiKey: newApiKey };
    } catch (error) {
        console.error('Error creating API key:', error);
        return { success: false, error: 'Failed to create API key.' };
    }
}

const deleteApiKeySchema = z.object({
  apiKeyId: z.string(),
});

export async function deleteUserApiKey(formData: FormData): Promise<{ success: boolean; error?: string }> {
  const user = await getUserFromSession();
  if (!user) {
    return { success: false, error: 'Authentication required.' };
  }

  const result = deleteApiKeySchema.safeParse(Object.fromEntries(formData));

  if (!result.success) {
    return { success: false, error: 'Invalid API Key ID.' };
  }
  
  const { apiKeyId } = result.data;
  
  try {
      const allKeys = await readApiKeys();
      const keyToDelete = allKeys.find(k => k.id === apiKeyId);
      
      // Security check: user can only delete their own key
      if (!keyToDelete || keyToDelete.userId !== user.id) {
          return { success: false, error: 'API Key not found or you do not have permission.' };
      }
      
      await deleteApiKey(apiKeyId);
      return { success: true };
  } catch (error) {
    console.error('Error deleting API key:', error);
    return { success: false, error: 'Failed to delete API key.' };
  }
}

// Admin actions
export async function getApiKeysForAdmin(): Promise<{ keys?: ApiKey[], plans?: Plan[], error?: string }> {
    const user = await getUserFromSession();
    if (!user || user.role !== 'admin') {
        return { error: 'Unauthorized' };
    }
    const [keys, plans] = await Promise.all([readApiKeys(), readPlans()]);
    return { keys, plans };
}

const manageApiKeySchema = z.object({
  apiKeyId: z.string(),
  action: z.enum(['enable', 'disable', 'delete']),
});

export async function manageApiKey(formData: FormData): Promise<{ success: boolean, error?: string }> {
    const user = await getUserFromSession();
    if (!user || user.role !== 'admin') {
        return { success: false, error: 'Unauthorized' };
    }

    const result = manageApiKeySchema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
        return { success: false, error: 'Invalid action or API Key ID.' };
    }

    const { apiKeyId, action } = result.data;

    try {
        if (action === 'delete') {
            await deleteApiKey(apiKeyId);
            return { success: true };
        }
        
        const allKeys = await readApiKeys();
        const keyToUpdate = allKeys.find(k => k.id === apiKeyId);
        if (!keyToUpdate) {
            return { success: false, error: 'API Key not found.' };
        }

        keyToUpdate.isEnabled = (action === 'enable');
        await writeApiKey(keyToUpdate);
        
        return { success: true };
    } catch(e) {
        console.error(`Error managing API key ${apiKeyId}:`, e);
        return { success: false, error: 'Failed to update API key status.' };
    }
}

export async function getApiRequestLog(): Promise<{ logs?: ApiRequestLog[], error?: string }> {
    const user = await getUserFromSession();
    if (user?.role !== 'admin') {
        return { error: 'Unauthorized' };
    }
    
    try {
        const logs = await readApiRequestLog();
        return { logs };
    } catch (e) {
        console.error("Failed to fetch API request log:", e);
        return { error: 'Could not load API request log.' };
    }
}
