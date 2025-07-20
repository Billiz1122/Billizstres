
'use server';

import { z } from 'zod';
import type { User, ChatMessage } from '@/lib/types';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, setDoc, query, where, writeBatch, getDoc } from 'firebase/firestore';
import { getUserFromSession } from '@/lib/auth';


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

async function writeUser(user: User): Promise<void> {
    await setDoc(doc(db, 'users', user.id), user, { merge: true });
}

async function readChatMessage(messageId: string): Promise<ChatMessage | null> {
    const docRef = doc(db, 'chat_messages', messageId);
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? docSnap.data() as ChatMessage : null;
}

async function writeChatMessage(message: ChatMessage): Promise<void> {
    await setDoc(doc(db, 'chat_messages', message.id), message);
}

async function updateChatMessage(message: ChatMessage): Promise<void> {
    await setDoc(doc(db, 'chat_messages', message.id), message, { merge: true });
}

async function clearChatMessages(): Promise<void> {
    const q = query(collection(db, 'chat_messages'));
    const snapshot = await getDocs(q);
    const batch = writeBatch(db);
    snapshot.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
}

const sendMessageSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty.').max(500, 'Message is too long.'),
  replyToMessageId: z.string().optional(),
});

export async function sendMessage(formData: FormData) {
    const user = await getUserFromSession();
    if (!user) {
        return { success: false, error: 'Authentication required.' };
    }

    const result = sendMessageSchema.safeParse(Object.fromEntries(formData));

    if (!result.success) {
        const error = result.error.flatten().fieldErrors.message?.[0];
        return { success: false, error: error || 'Invalid message.' };
    }

    const { message, replyToMessageId } = result.data;

    const newMessage: ChatMessage = {
        id: crypto.randomUUID(),
        userId: user.id,
        message: message,
        timestamp: new Date().toISOString(),
        ...(replyToMessageId && { replyToMessageId }),
    };

    try {
        await writeChatMessage(newMessage);
        return { success: true };
    } catch (e) {
        console.error('Error sending message:', e);
        return { success: false, error: 'Failed to send message.' };
    }
}

// Action to pin a message
export async function pinMessage(messageId: string): Promise<{ success: boolean; error?: string }> {
    const user = await getUserFromSession();
    if (!user || user.role !== 'admin') {
        return { success: false, error: 'Unauthorized' };
    }

    try {
        const q = query(collection(db, 'chat_messages'), where('isPinned', '==', true));
        const pinnedSnapshot = await getDocs(q);

        const batch = writeBatch(db);
        
        // Unpin any currently pinned messages
        pinnedSnapshot.forEach(doc => {
            batch.update(doc.ref, { isPinned: false });
        });

        // Pin the new message
        const messageToPinRef = doc(db, 'chat_messages', messageId);
        batch.update(messageToPinRef, { isPinned: true });
        
        await batch.commit();
        
        return { success: true };
    } catch (e) {
        console.error('Error pinning message:', e);
        return { success: false, error: 'Failed to pin message.' };
    }
}

// Action to unpin a message
export async function unpinMessage(messageId: string): Promise<{ success: boolean; error?: string }> {
    const user = await getUserFromSession();
    if (!user || user.role !== 'admin') {
        return { success: false, error: 'Unauthorized' };
    }

    try {
        const messageToUnpinRef = doc(db, 'chat_messages', messageId);
        await setDoc(messageToUnpinRef, { isPinned: false }, { merge: true });
        
        return { success: true };
    } catch (e) {
        console.error('Error unpinning message:', e);
        return { success: false, error: 'Failed to unpin message.' };
    }
}


// ===== GIFT ACTIONS =====
const createGiftSchema = z.object({
    totalAmount: z.coerce.number().min(1, 'จำนวนเครดิตต้องมากกว่า 0'),
    numRecipients: z.coerce.number().int().min(1, 'จำนวนผู้รับต้องมีอย่างน้อย 1 คน'),
    distribution: z.enum(['equal', 'random']),
});

export async function createCreditGift(formData: FormData) {
    const user = await getUserFromSession();
    if (!user) {
        return { success: false, error: 'Authentication required.' };
    }

    const result = createGiftSchema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
        const error = Object.values(result.error.flatten().fieldErrors)[0]?.[0];
        return { success: false, error: error || 'ข้อมูลไม่ถูกต้อง' };
    }

    const { totalAmount, numRecipients, distribution } = result.data;
    
    if ((user.credits || 0) < totalAmount) {
        return { success: false, error: 'เครดิตของคุณไม่เพียงพอ' };
    }

    // --- Deduct credits and update user ---
    const gifter = await readUser(user.id);
    if (!gifter) return { success: false, error: 'ไม่พบผู้ใช้' }; // Should not happen
    
    gifter.credits -= totalAmount;
    await writeUser(gifter);

    // --- Generate shares ---
    let shares: number[] = [];
    if (distribution === 'equal') {
        const shareAmount = totalAmount / numRecipients;
        shares = Array(numRecipients).fill(shareAmount);
    } else { // random
        let remaining = totalAmount;
        for (let i = 0; i < numRecipients - 1; i++) {
            const randomShare = Math.random() * (remaining / (numRecipients - i));
            shares.push(randomShare);
            remaining -= randomShare;
        }
        shares.push(remaining); // Last person gets the rest
        shares = shares.sort(() => Math.random() - 0.5); // Shuffle
    }
    
    // --- Create gift message ---
    const giftMessage: ChatMessage = {
        id: crypto.randomUUID(),
        userId: user.id,
        message: `ส่งของขวัญเครดิต!`,
        timestamp: new Date().toISOString(),
        giftDetails: {
            giftId: crypto.randomUUID(),
            totalAmount: totalAmount,
            numRecipients: numRecipients,
            distribution: distribution,
            shares: shares.map(s => parseFloat(s.toFixed(2))), // Ensure 2 decimal places
            claimedBy: [],
            status: 'active'
        }
    };
    
    await writeChatMessage(giftMessage);

    return { success: true };
}


const claimGiftSchema = z.object({
  messageId: z.string(),
});

export async function claimCreditGift(formData: FormData) {
    const user = await getUserFromSession();
    if (!user) {
        return { success: false, error: 'Authentication required.' };
    }

    const result = claimGiftSchema.safeParse(Object.fromEntries(formData));
    if (!result.success) {
        return { success: false, error: 'Invalid gift ID.' };
    }

    const { messageId } = result.data;
    
    const giftMessage = await readChatMessage(messageId);
    if (!giftMessage || !giftMessage.giftDetails) {
        return { success: false, error: 'ไม่พบของขวัญนี้' };
    }

    if (giftMessage.userId === user.id) {
        return { success: false, error: 'คุณไม่สามารถรับของขวัญของตัวเองได้' };
    }

    if (giftMessage.giftDetails.status === 'fully_claimed') {
        return { success: false, error: 'ของขวัญนี้ถูกรับไปหมดแล้ว' };
    }

    if (giftMessage.giftDetails.claimedBy.includes(user.id)) {
        return { success: false, error: 'คุณได้รับของขวัญนี้ไปแล้ว' };
    }
    
    const claimer = await readUser(user.id);
    if (!claimer) {
        return { success: false, error: 'ไม่พบผู้ใช้' };
    }
    
    const shareIndex = giftMessage.giftDetails.claimedBy.length;
    const shareAmount = giftMessage.giftDetails.shares[shareIndex];
    
    claimer.credits = (claimer.credits || 0) + shareAmount;
    
    giftMessage.giftDetails.claimedBy.push(user.id);

    if (giftMessage.giftDetails.claimedBy.length >= giftMessage.giftDetails.numRecipients) {
        giftMessage.giftDetails.status = 'fully_claimed';
    }

    await writeUser(claimer);
    await updateChatMessage(giftMessage);
    
    return { success: true, message: `คุณได้รับ ${shareAmount.toFixed(2)} เครดิต!` };
}

export async function clearChat(): Promise<{ success: boolean; error?: string }> {
    const user = await getUserFromSession();
    if (!user || user.role !== 'admin') {
        return { success: false, error: 'Unauthorized' };
    }
    try {
        await clearChatMessages();
        return { success: true };
    } catch (error) {
        console.error("Failed to clear chat:", error);
        return { success: false, error: 'Could not clear chat messages.' };
    }
}
