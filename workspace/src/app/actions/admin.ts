
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { decrypt } from '@/lib/session';
import bcrypt from 'bcryptjs';
import type { Contact, Plan, User, AuditLogEntry, BannedIp, SiteSettings } from '@/lib/types';
import { headers } from 'next/headers';
import { db } from '@/lib/firebase';
import { collection, getDocs, doc, writeBatch, setDoc, query, orderBy, limit, deleteDoc, getDoc } from 'firebase/firestore';
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

async function readUsers(): Promise<User[]> {
  return getCollection<User>('users');
}

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

async function writeSiteSettings(settings: SiteSettings): Promise<void> {
  try {
    await setDoc(doc(db, 'settings', 'site'), settings, { merge: true });
  } catch(error) {
    console.error(`[Firestore Client Error] Failed to write site settings:`, error);
  }
}

async function readContacts(): Promise<Contact[]> {
  return getCollection<Contact>('contacts');
}

async function writeContacts(contacts: Contact[]): Promise<void> {
  try {
    const batch = writeBatch(db);
    const collectionRef = collection(db, 'contacts');
    const snapshot = await getDocs(collectionRef);
    snapshot.docs.forEach(existingDoc => batch.delete(doc(collectionRef, existingDoc.id)));
    contacts.forEach(contact => batch.set(doc(collectionRef, contact.id), contact));
    await batch.commit();
  } catch (error) {
    console.error(`[Firestore Client Error] Failed to write contacts:`, error);
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

async function writePlans(plans: Plan[]): Promise<void> {
  try {
    const batch = writeBatch(db);
    const collectionRef = collection(db, 'plans');
    const snapshot = await getDocs(collectionRef);
    snapshot.forEach(docToDelete => batch.delete(doc(collectionRef, docToDelete.id)));
    plans.forEach(plan => batch.set(doc(collectionRef, plan.id), plan));
    await batch.commit();
  } catch (error) {
    console.error(`[Firestore Client Error] Failed to write plans:`, error);
  }
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

async function writeBannedIp(ip: BannedIp): Promise<void> {
    try {
        const docRef = doc(db, 'banned_ips', ip.id);
        await setDoc(docRef, ip);
    } catch(error) {
        console.error(`[Firestore Client Error] Failed to write banned IP '${ip.id}':`, error);
    }
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

export async function getUsersForAdmin() {
    const user = await getUserFromSession();
    if (!user || !['admin', 'moderator'].includes(user.role)) return { error: 'Unauthorized' };
    const usersData = await readUsers();
    const users = usersData.map(({ password_hash, ...user }) => user);
    return { users };
}

export async function getPlansForAdmin() {
     const user = await getUserFromSession();
    if (!user || !['admin', 'moderator'].includes(user.role)) return { error: 'Unauthorized' };
    return { plans: await readPlans() };
}

export async function getContactsForAdmin() {
    const user = await getUserFromSession();
    if (!user || !['admin', 'moderator'].includes(user.role)) return { error: 'Unauthorized' };
    return { contacts: await readContacts() };
}

export async function getAuditLogs() {
    const user = await getUserFromSession();
    if (user?.role !== 'admin') return { error: 'Unauthorized' };
    return { logs: await readAuditLog() };
}

export async function getSiteSettingsForAdmin() {
    const user = await getUserFromSession();
    if (user?.role !== 'admin') return { error: 'Unauthorized' };
    return { settings: await readSiteSettings() };
}

async function logAdminAction(actor: Omit<User, 'password_hash'>, action: string, details: string, targetId?: string, targetUsername?: string) {
  try {
    const ip = getClientIp();
    const logEntry: AuditLogEntry = {
      id: crypto.randomUUID(), timestamp: new Date().toISOString(), actorId: actor.id, actorUsername: actor.username, action, ip, details, targetId, targetUsername,
    };
    const logs = await readAuditLog();
    const updatedLogs = [logEntry, ...logs].slice(0, 500); 
    await writeAuditLog(updatedLogs);
  } catch (error) {
    console.error("Failed to write to audit log:", error);
  }
}

const updateUserSchema = z.object({
  userId: z.string(),
  role: z.enum(['admin', 'moderator', 'user']),
  plan: z.string(),
  planExpiry: z.string().optional(),
  credits: z.coerce.number().min(0, 'Credits cannot be negative.'),
});

export async function updateUser(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (!sessionUser || !['admin', 'moderator'].includes(sessionUser.role)) return { success: false, error: 'Unauthorized' };
  
  const result = updateUserSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: Object.values(result.error.flatten().fieldErrors).flat().join(', ') || 'Invalid input.' };
  
  const { userId, role, plan: planId, planExpiry, credits } = result.data;

  try {
    const users = await readUsers();
    const plans = await readPlans();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return { success: false, error: 'User not found.' };

    const userToUpdate = users[userIndex];
    const newPlanSettings = plans.find(p => p.id === planId);
    if (!newPlanSettings) return { success: false, error: 'Selected plan does not exist.' };

    if (sessionUser.id !== userToUpdate.id) {
        const roleWeights = { admin: 2, moderator: 1, user: 0 };
        if (roleWeights[sessionUser.role] <= roleWeights[userToUpdate.role]) {
            return { success: false, error: 'คุณไม่มีสิทธิ์แก้ไขผู้ใช้ที่มีสิทธิ์เทียบเท่าหรือสูงกว่า' };
        }
    }
    if (userToUpdate.id === sessionUser.id && userToUpdate.role !== role) return { success: false, error: 'You cannot change your own role.' };
    if (userToUpdate.role === 'admin' && role !== 'admin') {
        const adminCount = users.filter(u => u.role === 'admin').length;
        if (adminCount <= 1) return { success: false, error: 'Cannot remove the last administrator.' };
    }

    users[userIndex] = { ...users[userIndex], role, plan: planId, credits: credits || 0, maxAttackTimeL4: newPlanSettings.maxAttackTimeL4, maxAttackTimeL7: newPlanSettings.maxAttackTimeL7, planAttacksPerHour: newPlanSettings.attacksPerHour, apiRequestsPerHour: newPlanSettings.apiRequestsPerHour || 0 };
    if (planExpiry && planExpiry.trim()) users[userIndex].planExpiry = new Date(planExpiry).toISOString();
    else delete users[userIndex].planExpiry;

    await writeUsers(users);
    await logAdminAction(sessionUser, 'update_user', `Set role to '${role}', plan to '${planId}', credits to ${credits}, and expiry to ${users[userIndex].planExpiry || 'none'}.`, userToUpdate.id, userToUpdate.username);
    revalidatePath('/admin');
    return { success: true };
  } catch (error) {
    console.error('Error updating user:', error);
    return { success: false, error: 'Failed to update user.' };
  }
}

const changePasswordSchema = z.object({ userId: z.string(), newPassword: z.string().min(6, 'Password must be at least 6 characters.') });

export async function changePassword(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (!sessionUser || !['admin', 'moderator'].includes(sessionUser.role)) return { success: false, error: 'Unauthorized' };
  const result = changePasswordSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: result.error.flatten().fieldErrors.newPassword?.[0] || 'Invalid input.' };
  
  const { userId, newPassword } = result.data;
  try {
    const users = await readUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return { success: false, error: 'User not found.' };
    const userToChange = users[userIndex];
    if (sessionUser.id !== userToChange.id) {
        const roleWeights = { admin: 2, moderator: 1, user: 0 };
        if (roleWeights[sessionUser.role] <= roleWeights[userToChange.role]) return { success: false, error: 'คุณไม่มีสิทธิ์เปลี่ยนรหัสผ่านของผู้ใช้ที่มีสิทธิ์เทียบเท่าหรือสูงกว่า' };
    }
    users[userIndex].password_hash = await bcrypt.hash(newPassword, 10);
    await writeUsers(users);
    await logAdminAction(sessionUser, 'change_password', `Changed password.`, userToChange.id, userToChange.username);
    revalidatePath('/admin');
    return { success: true };
  } catch (error) {
    console.error('Error changing password:', error);
    return { success: false, error: 'Failed to change password.' };
  }
}

const addUserSchema = z.object({ username: z.string().min(3, 'Username must be at least 3 characters.'), password: z.string().min(6, 'Password must be at least 6 characters.') });

export async function addUser(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
  const result = addUserSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: result.error.flatten().fieldErrors.username?.[0] || result.error.flatten().fieldErrors.password?.[0] || 'Invalid input.' };
  
  const { username, password } = result.data;
  try {
    const users = await readUsers();
    const plans = await readPlans();
    const freePlan = plans.find(p => p.id === 'free');
    if (!freePlan) return { success: false, error: 'Free plan not found. Cannot create new user.' };
    if (users.find(u => u.username === username)) return { success: false, error: 'Username already exists.' };

    const newUser: User = { id: crypto.randomUUID(), username, password_hash: await bcrypt.hash(password, 10), role: 'user', plan: 'free', credits: 0, maxAttackTimeL4: freePlan.maxAttackTimeL4, maxAttackTimeL7: freePlan.maxAttackTimeL7, planAttacksPerHour: freePlan.attacksPerHour, apiRequestsPerHour: freePlan.apiRequestsPerHour || 0, status: 'active', registrationIp: 'N/A (Admin Created)' };
    users.push(newUser);
    await writeUsers(users);
    await logAdminAction(sessionUser, 'add_user', `Created new user with username '${username}'.`, newUser.id, newUser.username);
    revalidatePath('/admin');
    return { success: true };
  } catch (error) {
    console.error('Error adding user:', error);
    return { success: false, error: 'Failed to add user.' };
  }
}

const banUserSchema = z.object({ userId: z.string(), reason: z.string().optional(), banIp: z.enum(['on', 'off']).optional() });

export async function banUser(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (!sessionUser || !['admin', 'moderator'].includes(sessionUser.role)) return { success: false, error: 'Unauthorized' };
  const result = banUserSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: 'Invalid input.' };
  
  const { userId, reason, banIp } = result.data;
  if (userId === sessionUser.id) return { success: false, error: 'You cannot ban your own account.' };

  try {
    const users = await readUsers();
    const userToBan = users.find(u => u.id === userId);
    if (!userToBan) return { success: false, error: 'User not found.' };
    if (userToBan.role === 'admin') return { success: false, error: 'Administrators cannot be banned.' };

    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return { success: false, error: 'User not found.' };
    
    users[userIndex].status = 'banned';
    if (reason && reason.trim()) users[userIndex].banReason = reason;
    else delete users[userIndex].banReason;
    await writeUsers(users);

    let logDetails = `Banned user. Reason: ${reason || 'Not specified'}.`;
    if (banIp === 'on' && userToBan.registrationIp && userToBan.registrationIp !== 'N/A (Admin Created)') {
        await writeBannedIp({ id: userToBan.registrationIp, reason: `Associated with banned user: ${userToBan.username}. Ban reason: ${reason || 'Not specified'}.`, bannedBy: sessionUser.id, bannedByUsername: sessionUser.username, timestamp: new Date().toISOString() });
        logDetails += ` Also banned registration IP: ${userToBan.registrationIp}.`;
    }
    await logAdminAction(sessionUser, 'ban_user', logDetails, userToBan.id, userToBan.username);
    revalidatePath('/admin');
    return { success: true };
  } catch (error) {
    console.error('Error banning user:', error);
    return { success: false, error: 'Failed to ban user.' };
  }
}

const unbanUserSchema = z.object({ userId: z.string() });

export async function unbanUser(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (!sessionUser || !['admin', 'moderator'].includes(sessionUser.role)) return { success: false, error: 'Unauthorized' };
  const result = unbanUserSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: 'Invalid input.' };

  const { userId } = result.data;
  try {
    const users = await readUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return { success: false, error: 'User not found.' };
    const userToUnban = users[userIndex];
    userToUnban.status = 'active';
    delete userToUnban.banReason;
    await writeUsers(users);
    await logAdminAction(sessionUser, 'unban_user', `Unbanned user.`, userToUnban.id, userToUnban.username);
    revalidatePath('/admin');
    return { success: true };
  } catch (error) {
    console.error('Error unbanning user:', error);
    return { success: false, error: 'Failed to unban user.' };
  }
}

const siteSettingsSchema = z.object({
  appName: z.string().min(1, 'App name cannot be empty.'),
  logoUrl: z.string().url('Invalid logo URL.').or(z.literal('')),
  webhookUrl: z.string().url('Invalid main webhook URL.').or(z.literal('')),
  webhookUrlL4: z.string().url('Invalid L4 webhook URL.').or(z.literal('')),
  webhookUrlL7: z.string().url('Invalid L7 webhook URL.').or(z.literal('')),
  webhookUrlSms: z.string().url('Invalid SMS webhook URL.').or(z.literal('')),
  discordServerId: z.string().regex(/^\d*$/, { message: 'Discord Server ID must be numeric.' }).or(z.literal('')),
  backgroundImageUrl: z.string().url('Invalid background image URL.').or(z.literal('')),
  backgroundOpacity: z.coerce.number().min(0).max(1),
  successMessage: z.string().min(1, 'The API response message cannot be empty.'),
  recipientPhone: z.string().optional(),
  paidPlanPrice: z.coerce.number().min(0),
  plusPlanPrice: z.coerce.number().min(0),
  promptPayId: z.string().optional(),
  landingTagline: z.string().optional(),
  landingSubTagline: z.string().optional(),
  isApiEnabled: z.enum(['on', 'off']).optional(),
});

export async function updateSiteSettings(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
  const result = siteSettingsSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: Object.values(result.error.flatten().fieldErrors).flat().join(', ') };
  
  const { isApiEnabled, ...settingsData } = result.data;
  const isApiEnabledBool = isApiEnabled === 'on';
  try {
    const currentSettings = await readSiteSettings();
    const newSettings = { ...currentSettings, ...settingsData, isApiEnabled: isApiEnabledBool };
    await writeSiteSettings(newSettings);
    await logAdminAction(sessionUser, 'update_site_settings', 'Updated general site settings.');
    revalidatePath('/', 'layout');
    return { success: true };
  } catch (error) {
    console.error('Error updating site settings:', error);
    return { success: false, error: 'Failed to update site settings.' };
  }
}

const contactSchema = z.object({ id: z.string().optional(), name: z.string().min(1, 'Name is required.'), url: z.string().url('Invalid URL.'), icon: z.string().min(1, 'Icon is required.') });

export async function addContact(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
  const result = contactSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: Object.values(result.error.flatten().fieldErrors)[0]?.[0] || 'Invalid input.' };
  
  const { name, url, icon } = result.data;
  try {
    const contacts = await readContacts();
    const newContact: Contact = { id: crypto.randomUUID(), name, url, icon };
    contacts.push(newContact);
    await writeContacts(contacts);
    await logAdminAction(sessionUser, 'add_contact', `Added new contact: '${name}' with URL '${url}'.`, newContact.id, name);
    revalidatePath('/admin');
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Error adding contact:', error);
    return { success: false, error: 'Failed to add contact.' };
  }
}

export async function updateContact(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
  const result = contactSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success || !result.data.id) return { success: false, error: Object.values(result.error.flatten().fieldErrors)[0]?.[0] || 'Invalid input or missing ID.' };
  
  const { id, name, url, icon } = result.data;
  try {
    const contacts = await readContacts();
    const contactIndex = contacts.findIndex(c => c.id === id);
    if (contactIndex === -1) return { success: false, error: 'Contact not found.' };
    contacts[contactIndex] = { ...contacts[contactIndex], name, url, icon };
    await writeContacts(contacts);
    await logAdminAction(sessionUser, 'update_contact', `Updated contact '${name}'.`, id, name);
    revalidatePath('/admin');
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Error updating contact:', error);
    return { success: false, error: 'Failed to update contact.' };
  }
}

const deleteContactSchema = z.object({ contactId: z.string() });

export async function deleteContact(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
  const result = deleteContactSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: 'Invalid input.' };
  
  const { contactId } = result.data;
  try {
    const contacts = await readContacts();
    const deletedContact = contacts.find(c => c.id === contactId);
    const updatedContacts = contacts.filter(c => c.id !== contactId);
    await writeContacts(updatedContacts);
    if (deletedContact) await logAdminAction(sessionUser, 'delete_contact', `Deleted contact: '${deletedContact.name}'.`, deletedContact.id, deletedContact.name);
    revalidatePath('/admin');
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Error deleting contact:', error);
    return { success: false, error: 'Failed to delete contact.' };
  }
}

const planSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1, 'Name is required'),
    price: z.coerce.number().min(0, "Price must be 0 or more"),
    salePrice: z.coerce.number().min(0, "Sale Price must be 0 or more").optional().or(z.literal('')),
    maxAttackTimeL4: z.coerce.number().min(1, 'Max L4 attack time is required'),
    maxAttackTimeL7: z.coerce.number().min(1, 'Max L7 attack time is required'),
    attacksPerHour: z.coerce.number().min(0, 'Attacks per hour is required'),
    apiRequestsPerHour: z.coerce.number().min(0, 'API Requests per hour is required').optional(),
    defaultDurationDays: z.coerce.number().min(1, 'Duration is required'),
    canCreateApiKeys: z.enum(['on', 'off']).optional(),
});

export async function addPlan(formData: FormData) {
    const sessionUser = await getUserFromSession();
    if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
    const result = planSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!result.success) return { success: false, error: Object.values(result.error.flatten().fieldErrors)[0]?.[0] || 'Invalid input.' };

    const { salePrice, canCreateApiKeys, ...newPlanData } = result.data;
    const salePriceValue = salePrice === '' ? undefined : salePrice;
    try {
        const plans = await readPlans();
        const newPlan: Plan = { ...newPlanData, id: crypto.randomUUID(), salePrice: salePriceValue, apiRequestsPerHour: newPlanData.apiRequestsPerHour || 0, canCreateApiKeys: canCreateApiKeys === 'on' };
        plans.push(newPlan);
        await writePlans(plans);
        await logAdminAction(sessionUser, 'add_plan', `Added new plan: '${newPlan.name}'`);
        revalidatePath('/admin');
        revalidatePath('/store');
        return { success: true };
    } catch (e) {
        console.error("Error adding plan:", e);
        return { success: false, error: 'Failed to add plan.' };
    }
}

export async function updatePlan(formData: FormData) {
    const sessionUser = await getUserFromSession();
    if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
    const result = planSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!result.success || !result.data.id) return { success: false, error: Object.values(result.error.flatten().fieldErrors)[0]?.[0] || 'Invalid input or missing ID.' };

    const { id, salePrice, canCreateApiKeys, ...updatedValues } = result.data;
    const salePriceValue = salePrice === '' ? undefined : salePrice;
    try {
        const plans = await readPlans();
        const planIndex = plans.findIndex(p => p.id === id);
        if (planIndex === -1) return { success: false, error: 'Plan not found.' };

        plans[planIndex] = { ...plans[planIndex], ...updatedValues, salePrice: salePriceValue, apiRequestsPerHour: updatedValues.apiRequestsPerHour || 0, canCreateApiKeys: canCreateApiKeys === 'on' };
        if (salePriceValue === undefined) delete plans[planIndex].salePrice;
        await writePlans(plans);
        await logAdminAction(sessionUser, 'update_plan', `Updated plan: '${updatedValues.name}'`);
        revalidatePath('/admin');
        revalidatePath('/store');
        revalidatePath('/landing');
        return { success: true };
    } catch (e) {
        console.error("Error updating plan:", e);
        return { success: false, error: 'Failed to save plan settings.' };
    }
}

const deletePlanSchema = z.object({ planId: z.string() });

export async function deletePlan(formData: FormData) {
    const sessionUser = await getUserFromSession();
    if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
    const result = deletePlanSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!result.success) return { success: false, error: 'Invalid input.' };
    const { planId } = result.data;
    if (planId === 'free') return { success: false, error: 'Cannot delete the default Free plan.' };

    try {
        const plans = await readPlans();
        const users = await readUsers();
        if (users.some(u => u.plan === planId)) return { success: false, error: 'Cannot delete plan, it is currently in use by one or more users.' };

        const planToDelete = plans.find(p => p.id === planId);
        const updatedPlans = plans.filter(p => p.id !== planId);
        await writePlans(updatedPlans);
        if (planToDelete) await logAdminAction(sessionUser, 'delete_plan', `Deleted plan: '${planToDelete.name}'`);
        revalidatePath('/admin');
        revalidatePath('/store');
        return { success: true };
    } catch (e) {
        console.error("Error deleting plan:", e);
        return { success: false, error: 'Failed to delete plan.' };
    }
}

const giveCreditsToAllSchema = z.object({ amount: z.coerce.number().positive('Amount must be a positive number.') });

export async function giveCreditsToAll(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
  const result = giveCreditsToAllSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: result.error.flatten().fieldErrors.amount?.[0] || 'Invalid amount.' };

  const { amount } = result.data;
  try {
    const users = await readUsers();
    const updatedUsers = users.map(user => ({ ...user, credits: (user.credits || 0) + amount }));
    await writeUsers(updatedUsers);
    await logAdminAction(sessionUser, 'give_credits_all', `Gave ${amount} credits to all users.`);
    revalidatePath('/admin');
    return { success: true };
  } catch (error) {
    console.error('Error giving credits to all users:', error);
    return { success: false, error: 'Failed to give credits to all users.' };
  }
}

const removeCreditsSchema = z.object({ amount: z.coerce.number().positive('Amount must be a positive number.') });

export async function removeCreditsFromAll(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (sessionUser?.role !== 'admin') return { success: false, error: 'Unauthorized' };
  const result = removeCreditsSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!result.success) return { success: false, error: result.error.flatten().fieldErrors.amount?.[0] || 'Invalid amount.' };
  
  const { amount } = result.data;
  try {
    const users = await readUsers();
    const updatedUsers = users.map(user => ({ ...user, credits: Math.max(0, (user.credits || 0) - amount) }));
    await writeUsers(updatedUsers);
    await logAdminAction(sessionUser, 'remove_credits_all', `Removed ${amount} credits from all users.`);
    revalidatePath('/admin');
    return { success: true };
  } catch (error) {
    console.error('Error removing credits from all users:', error);
    return { success: false, error: 'Failed to remove credits from all users.' };
  }
}
