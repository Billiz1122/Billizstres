
import { getUserFromSession } from "@/lib/auth";
import { StatCard } from "@/components/stat-card";
import { BarChart, Users, Shield, Server } from 'lucide-react';
import { redirect } from "next/navigation";
import { DashboardClientPage } from "@/app/dashboard/dashboard-client-page";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { User, AttackHistoryJob } from "@/lib/types";

async function readUsers(): Promise<User[]> {
    const snapshot = await getDocs(collection(db, 'users'));
    return snapshot.docs.map(doc => doc.data() as User);
}

async function readAttackHistory(): Promise<AttackHistoryJob[]> {
    const snapshot = await getDocs(collection(db, 'attack_history'));
    return snapshot.docs.map(doc => doc.data() as AttackHistoryJob);
}


export default async function DashboardPage() {
  const user = await getUserFromSession();

  if (!user) {
    redirect('/login');
  }

  const [allUsersData, attackHistory] = await Promise.all([
    readUsers(),
    readAttackHistory(),
  ]);

  const allUsers = allUsersData.map(({ password_hash, ...user }) => user);
  const totalUsers = allUsers.length;
  const totalAttacks = attackHistory.length;
  const attacksLast24h = attackHistory.filter(a => new Date(a.timestamp) > new Date(Date.now() - 24 * 60 * 60 * 1000)).length;
  const serverCount = 21;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="ผู้ใช้งานทั้งหมด" value={totalUsers} icon={<Users />} />
        <StatCard title="การโจมตีทั้งหมด" value={totalAttacks} icon={<BarChart />} />
        <StatCard title="การโจมตีใน 24 ชม." value={attacksLast24h} icon={<Shield />} />
        <StatCard title="เซิฟเวอร์โจมตี" value={serverCount} icon={<Server />} />
      </div>

      <DashboardClientPage 
        user={user} 
        users={allUsers}
      />
    </div>
  );
}
