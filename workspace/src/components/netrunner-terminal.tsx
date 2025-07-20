
'use client';

import { useState } from 'react';
import { handleCommand, executeAiAttackPlan } from '@/app/actions/handle-command';
import type { AttackInput, AttackJob } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';

import { Button } from './ui/button';
import { Input } from './ui/input';
import { AlertTriangle, BrainCircuit, ChevronRight, LoaderCircle, Terminal } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { ScrollArea } from './ui/scroll-area';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';

interface NetrunnerTerminalProps {
    onAttackAdded: () => void;
}

export function NetrunnerTerminal({ onAttackAdded }: NetrunnerTerminalProps) {
    const [command, setCommand] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isExecuting, setIsExecuting] = useState(false);
    const [response, setResponse] = useState<{ attackPlan: AttackJob[], reasoning: string, error?: string } | null>(null);
    const { toast } = useToast();

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!command.trim()) return;

        setIsLoading(true);
        setResponse(null);

        const result = await handleCommand(command);
        setResponse(result);
        setIsLoading(false);
    };
    
    const handleExecute = async () => {
        if (!response?.attackPlan || response.attackPlan.length === 0) return;
        
        setIsExecuting(true);
        const result = await executeAiAttackPlan(response.attackPlan);
        
        if (result.success) {
            toast({
                title: 'สำเร็จ',
                description: result.message || 'เพิ่มแผนการโจมตีเข้าคิวแล้ว',
            });
            onAttackAdded();
            setResponse(null);
            setCommand('');
        } else {
            toast({
                variant: 'destructive',
                title: 'เกิดข้อผิดพลาด',
                description: result.error || 'ไม่สามารถเพิ่มแผนการโจมตีเข้าคิวได้'
            });
        }
        setIsExecuting(false);
    }

    return (
        <Card className="bg-black/50 border-primary/30 backdrop-blur-md h-full flex flex-col">
            <CardHeader>
                <CardTitle className="text-primary text-glow-primary flex items-center gap-2"><Terminal /> คอนโซลคำสั่ง AI</CardTitle>
                <CardDescription>ใช้ภาษาธรรมชาติเพื่อสั่งการโจมตีที่ซับซ้อน</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 flex-grow min-h-0">
                <form onSubmit={handleSubmit} className="flex gap-2">
                    <ChevronRight className="text-accent h-9 flex-shrink-0 mt-0.5" />
                    <Input 
                        name="command" 
                        placeholder="เช่น tcp flood 1.1.1.1 on port 80 for 30s then..."
                        className="bg-transparent font-code"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        disabled={isLoading || isExecuting}
                    />
                    <Button type="submit" disabled={isLoading || isExecuting} variant="outline" className="text-accent border-accent hover:bg-accent/20 hover:text-accent">
                        {isLoading ? <LoaderCircle className="animate-spin" /> : 'ส่ง'}
                    </Button>
                </form>

                <div className="flex-grow min-h-0">
                    <ScrollArea className="h-full">
                        <div className="pr-4 space-y-4 pb-4">
                            {isLoading && (
                                <div className="flex items-center gap-2 text-muted-foreground animate-pulse p-4 justify-center">
                                    <LoaderCircle className="animate-spin" />
                                    <p>AI กำลังประมวลผลคำสั่งของคุณ...</p>
                                </div>
                            )}

                            {response?.error && (
                                <div className="flex items-center gap-2 text-destructive p-3 rounded-md bg-destructive/20 border border-destructive/50">
                                    <AlertTriangle />
                                    <p>{response.error}</p>
                                </div>
                            )}

                            {response?.reasoning && (
                                <div className="p-3 rounded-md bg-muted/30 border border-border">
                                    <h3 className="flex items-center gap-2 text-accent font-semibold mb-2">
                                        <BrainCircuit /> เหตุผลของ AI
                                    </h3>
                                    <p className="text-sm text-muted-foreground whitespace-pre-wrap font-code">{response.reasoning}</p>
                                </div>
                            )}
                            
                            {response?.attackPlan && response.attackPlan.length > 0 && (
                                <div className="p-3 rounded-md bg-muted/30 border border-border">
                                     <h3 className="text-primary font-semibold mb-2">แผนการโจมตีที่สร้างขึ้น</h3>
                                     <div className="space-y-2">
                                        {response.attackPlan.map(job => (
                                            <div key={job.id} className="text-sm p-2 rounded-md bg-background/50 border border-border flex justify-between items-center">
                                                <div>
                                                    <p className="font-bold">{job.method} <span className="font-normal text-muted-foreground">บน</span> {job.host}:{job.port}</p>
                                                    <p className="text-xs text-muted-foreground">{job.time} วินาที</p>
                                                </div>
                                                <Badge variant="outline">{job.method}</Badge>
                                            </div>
                                        ))}
                                     </div>
                                     <Separator className="my-3 bg-border" />
                                     <Button onClick={handleExecute} className="w-full" disabled={isExecuting}>
                                        {isExecuting && <LoaderCircle className="animate-spin mr-2" />}
                                        เพิ่มแผนเข้าคิว
                                    </Button>
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                </div>
            </CardContent>
        </Card>
    );
}
