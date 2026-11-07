import { PasswordForm } from './password-form';

export const metadata = { title: 'Security' };

export default function SecurityPage() {
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Security</h1>
        <p className="text-sm text-muted-foreground">Protect your account</p>
      </div>
      <PasswordForm />
    </>
  );
}
