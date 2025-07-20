
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Transaction, Plan, User, SiteSettings } from '@/lib/types';
import { addDays } from 'date-fns';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, writeBatch, setDoc, query, orderBy, getDoc } from 'firebase/firestore';
import { getUserFromSession } from '@/lib/auth';


// ================================================================= //
// Helper function to handle reading collections
// ================================================================= //
async function getCollection<T>(collectionName: string): Promise<T[]> {
  try {
    const collectionRef = collection(db, collectionName);
    const snapshot = await getDocs(collectionRef);
    if (snapshot.empty) {
      return [];
    }
    return snapshot.docs.map(doc => doc.data() as T);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Firestore Client Error] Failed to read collection '${collectionName}':`, errorMessage);
    return [];
  }
}

async function getCollectionWithQuery<T>(q: any): Promise<T[]> {
  try {
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      return [];
    }
    return snapshot.docs.map(doc => doc.data() as T);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Firestore Client Error] Failed to query collection:`, errorMessage);
    return [];
  }
}

// ================================================================= //
// DB functions that were in db.ts are now here
// ================================================================= //
async function readUser(userId: string): Promise<User | null> {
    try {
        const userDocRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            return null;
        }
        return userDoc.data() as User;
    } catch (error) {
        console.error(`[Firestore Client Error] Failed to read user '${userId}':`, error);
        return null;
    }
}

async function readUsers(): Promise<User[]> {
  return getCollection<User>('users');
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

async function readTransactions(): Promise<Transaction[]> {
    const q = query(collection(db, 'transactions'), orderBy('createdAt', 'desc'));
    return getCollectionWithQuery<Transaction>(q);
}

async function writeTransactions(transactions: Transaction[]): Promise<void> {
    try {
        const batch = writeBatch(db);
        const collectionRef = collection(db, 'transactions');
        
        // This is a "replace all" approach. A more sophisticated approach would
        // be to only write the changed/new transactions. For simplicity, this is fine.
        const snapshot = await getDocs(collectionRef);
        snapshot.forEach(docToDelete => batch.delete(doc(collectionRef, docToDelete.id)));
        
        transactions.forEach(transaction => batch.set(doc(collectionRef, transaction.id), transaction));
        
        await batch.commit();
    } catch (error) {
        console.error(`[Firestore Client Error] Failed to write transactions:`, error);
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
// Action logic starts here
// ================================================================= //

// This function is for manual approval/rejection by admins
const manageTransactionSchema = z.object({
  transactionId: z.string(),
  action: z.enum(['approve', 'reject']),
});

export async function manageTransaction(formData: FormData) {
    const sessionUser = await getUserFromSession();
    if (!sessionUser || !['admin', 'moderator'].includes(sessionUser.role)) {
        return { success: false, error: 'Unauthorized' };
    }
    
    const result = manageTransactionSchema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
        return { success: false, error: 'Invalid input' };
    }
    
    const { transactionId, action } = result.data;

    const transactions = await readTransactions();
    const transactionIndex = transactions.findIndex(t => t.id === transactionId);

    if (transactionIndex === -1) {
        return { success: false, error: 'Transaction not found.' };
    }
    
    const transaction = transactions[transactionIndex];
    if (transaction.status !== 'pending') {
        return { success: false, error: 'This transaction has already been processed.' };
    }

    if (action === 'approve') {
        const users = await readUsers();
        const userIndex = users.findIndex(u => u.id === transaction.userId);
        if (userIndex === -1) {
            transaction.status = 'rejected';
            transaction.notes = 'User not found at time of approval.';
            await writeTransactions([transaction, ...transactions.filter(t => t.id !== transactionId)]);
            return { success: false, error: 'User to apply credits to was not found.' };
        }
        
        const user = users[userIndex];
        user.credits = (user.credits || 0) + transaction.amount;
        
        await writeUsers(users);
        
        transaction.status = 'approved';

    } else { // 'reject'
        transaction.status = 'rejected';
    }
    
    transaction.processedBy = sessionUser.username;
    transaction.processedAt = new Date().toISOString();
    
    await writeTransactions([transaction, ...transactions.filter(t => t.id !== transactionId)]);
    
    revalidatePath('/admin/transactions');
    revalidatePath('/admin');
    revalidatePath('/top-up');
    
    return { success: true };
}

// ===== Automatic Voucher Redemption =====

const redeemVoucherSchema = z.object({
  voucherUrl: z.string().url('กรุณาใส่ลิงก์ซองอั่งเปาที่ถูกต้อง'),
});

function extractVoucherHash(url: string): string | null {
    try {
        const urlObj = new URL(url);
        const pathSegments = urlObj.pathname.split('/');
        const vIndex = pathSegments.indexOf('v');
        if (vIndex !== -1 && vIndex + 1 < pathSegments.length) {
            return pathSegments[vIndex + 1];
        }
        // Fallback for URLs like /campaign/vouchers?v=...
        const vParam = urlObj.searchParams.get('v');
        if (vParam) return vParam;
        
        return null;
    } catch {
        // Fallback for non-URL strings
        const match = url.match(/v=([a-zA-Z0-9_-]+)/) || url.match(/\/v\/([a-zA-Z0-9_-]+)/);
        return match ? match[1] : null;
    }
}


export async function redeemVoucher(formData: FormData) {
    const sessionUser = await getUserFromSession();
    if (!sessionUser) {
        return { success: false, error: 'Authentication required.' };
    }

    const result = redeemVoucherSchema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
        const error = Object.values(result.error.flatten().fieldErrors)[0]?.[0];
        return { success: false, error: error || 'ข้อมูลไม่ถูกต้อง' };
    }

    const { voucherUrl } = result.data;
    const settings = await readSiteSettings();
    
    if (!settings.recipientPhone) {
        return { success: false, error: 'ผู้ดูแลยังไม่ได้ตั้งค่าเบอร์โทรศัพท์ผู้รับเงิน' };
    }

    const voucherHash = extractVoucherHash(voucherUrl);
    if (!voucherHash) {
        return { success: false, error: 'ไม่สามารถดึงข้อมูลจากลิงก์ซองอั่งเปาได้' };
    }
    
    // Check for duplicate voucher hash
    const allTransactions = await readTransactions();
    if (allTransactions.some(t => t.slipTransactionRef === voucherHash && t.status === 'approved')) {
        return { success: false, error: 'ซองอั่งเปานี้ถูกใช้งานไปแล้ว' };
    }

    try {
        const response = await fetch(`https://gift.truemoney.com/campaign/vouchers/${voucherHash}/redeem`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                mobile: settings.recipientPhone,
                voucher_hash: voucherHash
            })
        });

        const redeemData = await response.json();
        if (redeemData.status.code !== 'SUCCESS') {
            return { success: false, error: redeemData.status.message || 'ไม่สามารถรับซองอั่งเปาได้' };
        }
        
        const amount = parseFloat(redeemData.data.my_ticket.amount_baht);
        
        // --- If successful, create transaction and update user credits ---
        const allUsers = await readUsers();
        const userIndex = allUsers.findIndex(u => u.id === sessionUser.id);
        if (userIndex === -1) {
            return { success: false, error: 'User not found' }; // Should not happen
        }

        const user = allUsers[userIndex];
        user.credits = (user.credits || 0) + amount;
        
        await writeUsers(allUsers);

        const newTransaction: Transaction = {
            id: crypto.randomUUID(),
            userId: user.id,
            username: user.username,
            amount,
            status: 'approved',
            createdAt: new Date().toISOString(),
            processedAt: new Date().toISOString(),
            processedBy: 'System (Voucher)',
            slipTransactionRef: voucherHash,
            notes: `Auto-redeemed ${amount} credits from voucher.`
        };
        
        await writeTransactions([newTransaction, ...allTransactions]);

        revalidatePath('/top-up');
        revalidatePath('/profile');
        revalidatePath('/admin/transactions');

        return { success: true, message: `เติมเครดิตสำเร็จ! คุณได้รับ ${amount} เครดิต` };

    } catch (error: any) {
        console.error("Redemption error:", error);
        const errorMessage = error.response?.data?.status?.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อกับ TrueMoney';
        return { success: false, error: errorMessage };
    }
}

// ===== Purchase Plan with Credits Action =====

const buyPlanSchema = z.object({
    planId: z.string().min(1, 'Plan ID is required'),
});

export async function buyPlan(formData: FormData) {
    const sessionUser = await getUserFromSession();
    if (!sessionUser) {
        return { success: false, error: 'Authentication required.' };
    }

    const result = buyPlanSchema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
        return { success: false, error: 'แผนที่เลือกไม่ถูกต้อง' };
    }
    
    const { planId } = result.data;
    if (planId === 'free') {
        return { success: false, error: 'ไม่สามารถซื้อแผนฟรีได้' };
    }
    
    try {
        const allUsers = await readUsers();
        const userIndex = allUsers.findIndex(u => u.id === sessionUser.id);
        if (userIndex === -1) {
            return { success: false, error: 'ไม่พบผู้ใช้ในระบบ' };
        }
        
        const user = allUsers[userIndex];
        const allPlans = await readPlans();
        const targetPlan = allPlans.find(p => p.id === planId);
        
        if (!targetPlan) {
            return { success: false, error: 'ไม่พบแผนที่ต้องการ' };
        }
        
        const priceToPay = targetPlan.salePrice !== undefined && targetPlan.salePrice < targetPlan.price 
            ? targetPlan.salePrice 
            : targetPlan.price;
        
        if ((user.credits || 0) < priceToPay) {
            return { success: false, error: `เครดิตไม่เพียงพอ (ต้องการ ${priceToPay} เครดิต)` };
        }
        
        // Deduct credits
        user.credits -= priceToPay;
        
        // Assign plan
        const now = new Date();
        const currentExpiry = user.planExpiry ? new Date(user.planExpiry) : now;
        const newExpiry = addDays(currentExpiry > now ? currentExpiry : now, targetPlan.defaultDurationDays);
        
        user.plan = planId;
        user.planAttacksPerHour = targetPlan.attacksPerHour;
        user.apiRequestsPerHour = targetPlan.apiRequestsPerHour || 0;
        user.maxAttackTimeL4 = targetPlan.maxAttackTimeL4;
        user.maxAttackTimeL7 = targetPlan.maxAttackTimeL7;
        user.planExpiry = newExpiry.toISOString();
        
        await writeUsers(allUsers);
        
        // Log this as a system transaction
        const transactions = await readTransactions();
        const purchaseTransaction: Transaction = {
            id: crypto.randomUUID(),
            userId: user.id,
            username: user.username,
            planId,
            amount: priceToPay,
            status: 'approved',
            createdAt: new Date().toISOString(),
            processedAt: new Date().toISOString(),
            processedBy: 'System (Store)',
            notes: `Purchased plan '${targetPlan.name}' with ${priceToPay} credits.`
        };
        
        await writeTransactions([purchaseTransaction, ...transactions]);

        revalidatePath('/store');
        revalidatePath('/profile');
        revalidatePath('/admin/transactions');

        return { success: true, message: `ซื้อแผน ${targetPlan.name} สำเร็จแล้ว!` };
        
    } catch (e: any) {
        console.error("Plan purchase error:", e);
        return { success: false, error: 'เกิดข้อผิดพลาดในการซื้อแผน' };
    }
}
