
'use server';

import { orchestrateAttackSequence } from '@/ai/flows/orchestrate-attack-sequence';
import { parseAttackCommand } from '@/ai/flows/parse-attack-command';
import type { AttackInput, AttackJob, User } from '@/lib/types';
import { addAttacksToQueue } from '@/app/actions/attack';
import { getUserFromSession } from '@/lib/auth';

interface HandleCommandResponse {
  attackPlan: AttackJob[];
  reasoning: string;
  error?: string;
}

const isComplexCommand = (command: string): boolean => {
  const complexKeywords = ['then', 'and', 'after', 'first', 'second', 'sequence', 'run'];
  return complexKeywords.some(keyword => command.toLowerCase().includes(keyword)) || command.split(' ').length > 15;
};

export async function handleCommand(command: string): Promise<HandleCommandResponse> {
  const user = await getUserFromSession();
  if (!user) {
      return { attackPlan: [], reasoning: '', error: 'Authentication required to use AI commands.' };
  }
    
  try {
    let attackPlan: AttackJob[] = [];
    let reasoning = '';

    if (isComplexCommand(command)) {
      const result = await orchestrateAttackSequence({ instructions: command });
      attackPlan = result.attackPlan.map(p => ({ ...p, id: crypto.randomUUID(), method: p.method.toUpperCase() }));
      reasoning = result.reasoning;
    } else {
      const result = await parseAttackCommand({ command });
      attackPlan = [{ ...result, id: crypto.randomUUID(), method: result.method.toUpperCase() }];
      reasoning = `Command parsed to launch a single ${result.method} attack.`;
    }
    
    if (attackPlan.length === 0 && !reasoning) {
        reasoning = "The command could not be parsed into a valid attack plan. Please try rephrasing."
    }

    return { attackPlan, reasoning };
  } catch (e: any) {
    console.error('Error handling command:', e);
    return { attackPlan: [], reasoning: '', error: e.message || 'Failed to parse command due to an internal error.' };
  }
}

export async function executeAiAttackPlan(attacks: AttackInput[]): Promise<{success: boolean, error?: string, message?: string}> {
  const user = await getUserFromSession();
  // Add a null check for the user object before passing it to addAttacksToQueue.
  if (!user) {
    return { success: false, error: 'Authentication required.' };
  }
  
  return await addAttacksToQueue(attacks, user);
}
