import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "niksen-flow | Investment Management",
  description: "Enterprise Portfolio & Task Tracking",
  icons: {
    icon: '/favicon.svg',
    apple:'/favicon.svg',
  },
  google: "a9Xz9Q_dR3_MIzA_Dgsp01YgxVIEu-CdTKFViW4oBMg",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased`}>
        {children}
      </body>
    </html>
  );
}