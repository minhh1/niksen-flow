// app/layout.tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import AppLoader from "@/components/AppLoader";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "niksen-flow",
  description: "Property & legal ERP",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AppLoader>
          {children}
        </AppLoader>
      </body>
    </html>
  );
}