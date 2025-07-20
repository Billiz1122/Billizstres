
'use server';

import { z } from 'zod';
import shortid from 'shortid';
import type { PhishingLink, PhishingLogEntry, User } from '@/lib/types';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, setDoc, query, orderBy, deleteDoc } from 'firebase/firestore';
import { getUserFromSession } from '@/lib/auth';


async function readPhishingLinks(): Promise<PhishingLink[]> {
    const q = query(collection(db, 'phishing_links'), orderBy('createdAt', 'desc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data() as PhishingLink);
}

async function writePhishingLink(link: PhishingLink): Promise<void> {
    await setDoc(doc(db, 'phishing_links', link.id), link);
}

async function readPhishingLog(): Promise<PhishingLogEntry[]> {
    const q = query(collection(db, 'phishing_log'), orderBy('timestamp', 'desc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data() as PhishingLogEntry);
}

async function writePhishingLogEntry(logEntry: PhishingLogEntry): Promise<void> {
    await setDoc(doc(db, 'phishing_log', logEntry.id), logEntry);
}


function getClientIp(): string {
    const headersList = headers();
    const forwardedFor = headersList.get('x-forwarded-for');
    if (forwardedFor) {
        return forwardedFor.split(',')[0].trim();
    }
    const realIp = headersList.get('x-real-ip');
    if (realIp) {
        return realIp.trim();
    }
    return '127.0.0.1';
}

const createLinkSchema = z.object({
  redirectUrl: z.string().url('Please enter a valid URL.'),
});

interface CreateLinkResponse {
  success: boolean;
  link?: PhishingLink;
  error?: string;
}

export async function createPhishingLink(formData: FormData): Promise<CreateLinkResponse> {
  const user = await getUserFromSession();
  if (!user) {
    return { success: false, error: 'Authentication required.' };
  }

  const result = createLinkSchema.safeParse(Object.fromEntries(formData));
  if (!result.success) {
    return { success: false, error: result.error.errors[0].message };
  }

  const { redirectUrl } = result.data;
  const linkId = shortid.generate();

  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://billiz.shop';
  const fullUrl = `${appBaseUrl}/p/${linkId}`;
  
  try {
    const tinyUrlResponse = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(fullUrl)}`);
    if (!tinyUrlResponse.ok) {
      const errorText = await tinyUrlResponse.text();
      console.error('TinyURL API Error:', errorText);
      throw new Error(`Failed to shorten URL with TinyURL. Status: ${tinyUrlResponse.status}`);
    }
    const shortUrl = await tinyUrlResponse.text();

    const newLink: PhishingLink = {
      id: linkId,
      userId: user.id,
      redirectUrl,
      shortUrl,
      createdAt: new Date().toISOString(),
    };

    await writePhishingLink(newLink);
    
    revalidatePath('/dashboard/phishing');

    return { success: true, link: newLink };
  } catch (error: any) {
    console.error('Error creating phishing link:', error);
    return { success: false, error: error.message || 'Could not create link.' };
  }
}

export async function getPhishingData(): Promise<{ links: PhishingLink[], logs: PhishingLogEntry[] }> {
    const user = await getUserFromSession();
    if (!user) {
        return { links: [], logs: [] };
    }
    
    const allLinks = await readPhishingLinks();
    const allLogs = await readPhishingLog();

    const userLinks = allLinks.filter(link => link.userId === user.id);
    const userLinkIds = new Set(userLinks.map(l => l.id));
    const userLogs = allLogs.filter(log => userLinkIds.has(log.linkId));
    
    return { links: userLinks, logs: userLogs };
}


const deleteLinkSchema = z.object({
  linkId: z.string(),
});

export async function deletePhishingLink(formData: FormData): Promise<{ success: boolean; error?: string }> {
  const user = await getUserFromSession();
  if (!user) {
    return { success: false, error: 'Authentication required.' };
  }

  const result = deleteLinkSchema.safeParse(Object.fromEntries(formData));
  if (!result.success) {
    return { success: false, error: 'Invalid input.' };
  }

  const { linkId } = result.data;

  try {
    const links = await readPhishingLinks();
    const linkToDelete = links.find(l => l.id === linkId);

    if (!linkToDelete || linkToDelete.userId !== user.id) {
      return { success: false, error: 'Link not found or you do not have permission to delete it.' };
    }

    await deleteDoc(doc(db, 'phishing_links', linkToDelete.id));
    
    // Also delete associated logs for good hygiene
    const logs = await readPhishingLog();
    const logsToDelete = logs.filter(log => log.linkId === linkId);
    for (const log of logsToDelete) {
        await deleteDoc(doc(db, 'phishing_log', log.id));
    }

    revalidatePath('/dashboard/phishing');

    return { success: true };
  } catch (error: any) {
    console.error('Error deleting phishing link:', error);
    return { success: false, error: 'Could not delete link.' };
  }
}
