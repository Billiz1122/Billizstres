
'use client';

import { useState } from 'react';
import type { User, Plan } from '@/lib/types';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Gem, CheckCircle, LoaderCircle, CreditCard, ShoppingCart, Hourglass, Target, Globe } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { buyPlan } from '@/app/actions/transactions';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import Link from 'next/link';

interface StoreClientPageProps {
    user: Omit<User, 'password_hash'>;
    plans: Plan[];
}

export function StoreClientPage({ user, plans }: StoreClientPageProps) {
    const { toast } = useToast();
    const [isLoading, setIsLoading] = useState<string | null>(null);

    const handleBuy = async (plan: Plan) => {
        setIsLoading(plan.id);

        const formData = new FormData();
        formData.append('planId', plan.id);
        
        const result = await buyPlan(formData);

        if (result.success) {
            toast({
                title: 'สำเร็จ!',
                description: result.message,
            });
        } else {
            toast({
                variant: 'destructive',
                title: 'เกิดข้อผิดพลาด',
                description: result.error,
            });
        }
        
        setIsLoading(null);
    };
    
    const userCredits = user.credits || 0;

    return (
        <main className="container mx-auto p-4 md:p-6">
            <div className="text-center mb-10">
                <h1 className="text-4xl font-bold text-primary text-glow-primary">ร้านค้า</h1>
                <p className="text-lg text-muted-foreground mt-2">ใช้เครดิตของคุณเพื่อซื้อแผนและรับสิทธิพิเศษ</p>
                <div className="mt-4 flex items-center justify-center gap-4">
                    <div className="flex items-center gap-2 p-2 px-4 rounded-full bg-muted/50">
                        <CreditCard className="w-6 h-6 text-accent" />
                        <span className="font-bold text-xl">{userCredits.toFixed(2)}</span>
                        <span className="text-muted-foreground">เครดิต</span>
                    </div>
                     <Button asChild>
                        <Link href="/top-up">
                            <Gem className="mr-2" /> เติมเครดิต
                        </Link>
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-8 max-w-4xl mx-auto">
                 {plans.map(plan => {
                    const hasSale = plan.salePrice !== undefined && plan.salePrice < plan.price;
                    const displayPrice = hasSale ? plan.salePrice : plan.price;
                    const canAfford = userCredits >= (displayPrice ?? 0);

                    return (
                    <Card key={plan.id} className="bg-background/50 flex flex-col">
                        <CardHeader className="text-center">
                            <Gem className="w-12 h-12 mx-auto text-primary" />
                            <CardTitle className="text-2xl mt-4">{plan.name}</CardTitle>
                            <CardDescription className="text-3xl font-bold text-accent text-glow-accent h-10 flex items-baseline justify-center gap-2">
                                {hasSale && (
                                    <span className="text-2xl text-muted-foreground line-through">{plan.price}</span>
                                )}
                                <span>{displayPrice}</span>
                                <span className="text-sm font-normal text-muted-foreground"> เครดิต / {plan.defaultDurationDays} วัน</span>
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex-grow space-y-3">
                            <p className="flex items-center"><Target className="w-5 h-5 mr-2 text-accent" /> เวลาโจมตี Layer4: <span className="font-bold ml-1">{plan.maxAttackTimeL4}</span> วินาที</p>
                            <p className="flex items-center"><Globe className="w-5 h-5 mr-2 text-accent" /> เวลาโจมตี Layer7: <span className="font-bold ml-1">{plan.maxAttackTimeL7}</span> วินาที</p>
                            <p className="flex items-center"><Hourglass className="w-5 h-5 mr-2 text-accent" /> การโจมตีต่อชั่วโมง: <span className="font-bold ml-1">{plan.attacksPerHour}</span></p>
                            <p className="flex items-center"><CheckCircle className="w-5 h-5 mr-2 text-accent" /> ลำดับคิวพิเศษ</p>
                        </CardContent>
                        <CardFooter>
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button className="w-full" disabled={isLoading === plan.id || !canAfford}>
                                        {isLoading === plan.id && <LoaderCircle className="animate-spin mr-2" />}
                                        <ShoppingCart className="mr-2" />
                                        {!canAfford ? 'เครดิตไม่เพียงพอ' : `ซื้อแผน ${plan.name}`}
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>ยืนยันการซื้อ</AlertDialogTitle>
                                        <AlertDialogDescription>
                                            คุณต้องการซื้อแผน {plan.name} ในราคา {displayPrice} เครดิตใช่หรือไม่? เครดิตจะถูกหักจากบัญชีของคุณทันที
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>ยกเลิก</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => handleBuy(plan)}>ยืนยัน</AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        </CardFooter>
                    </Card>
                 )})}
            </div>
        </main>
    );
}
