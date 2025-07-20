
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { User } from '@/lib/types';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
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

const updateAvatarSchema = z.object({
  avatarUrl: z.string().url("Please enter a valid URL.").or(z.literal('')),
});

export async function updateUserAvatar(formData: FormData) {
  const sessionUser = await getUserFromSession();
  if (!sessionUser) {
    return { success: false, error: 'Authentication required.' };
  }

  const result = updateAvatarSchema.safeParse(Object.fromEntries(formData));

  if (!result.success) {
    return { success: false, error: result.error.errors[0].message };
  }

  try {
    const userToUpdate = await readUser(sessionUser.id);
    if (!userToUpdate) {
        return { success: false, error: "User not found." };
    }

    userToUpdate.avatarUrl = result.data.avatarUrl;

    await writeUser(userToUpdate);

    revalidatePath('/profile');
    revalidatePath('/dashboard'); // To update chat component
    return { success: true };
  } catch (error) {
    console.error('Error updating avatar:', error);
    return { success: false, error: 'Failed to update avatar.' };
  }
}

const updateAboutMeSchema = z.object({
    aboutMe: z.string().max(200, "About me cannot be longer than 200 characters.").optional(),
});

export async function updateUserAboutMe(formData: FormData) {
    const sessionUser = await getUserFromSession();
    if (!sessionUser) {
        return { success: false, error: 'Authentication required.' };
    }

    const result = updateAboutMeSchema.safeParse(Object.fromEntries(formData));

    if (!result.success) {
        return { success: false, error: result.error.errors[0].message };
    }

    try {
        const userToUpdate = await readUser(sessionUser.id);
        if (!userToUpdate) {
            return { success: false, error: "User not found." };
        }

        userToUpdate.aboutMe = result.data.aboutMe;

        await writeUser(userToUpdate);

        revalidatePath('/profile');
        return { success: true };
    } catch (error) {
        console.error('Error updating about me:', error);
        return { success: false, error: 'Failed to update about me.' };
    }
}
