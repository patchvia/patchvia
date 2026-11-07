export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-5">{children}</div>
  );
}
