import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LeanMarketing",
  description: "Built by Persona Engine",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 dark:bg-gray-900 min-h-screen">
        {children}
      </body>
    </html>
  );
}
