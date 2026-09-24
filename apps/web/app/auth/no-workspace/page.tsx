import { AuthCard } from '@/components/auth/auth-card';

export default function NoWorkspacePage() {
  return (
    <AuthCard title="No active workspace" description="Your account is not an active member of any workspace. Ask an administrator for an invitation.">
      <form action="/api/v1/auth/sign-out" method="post" />
      <a href="/auth/sign-in" className="text-[14px] font-semibold text-primary hover:underline">
        Back to Sign In
      </a>
    </AuthCard>
  );
}
