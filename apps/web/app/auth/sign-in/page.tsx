import { Suspense } from 'react';
import { SignInForm } from './sign-in-form';

export const metadata = { title: 'Sign In' };

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
