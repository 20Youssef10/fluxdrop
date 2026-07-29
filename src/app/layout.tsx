import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/fluxdrop/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FluxDrop — Peer-to-Peer File Transfer",
  description:
    "Send files directly between devices over WebRTC. No cloud, no servers, no storage. End-to-end encrypted, blazing fast, zero footprint.",
  keywords: [
    "FluxDrop",
    "WebRTC",
    "P2P file transfer",
    "direct file share",
    "encrypted transfer",
    "no cloud",
  ],
  authors: [{ name: "FluxDrop" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "FluxDrop — Peer-to-Peer File Transfer",
    description: "Direct, encrypted, serverless file transfer between devices.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "FluxDrop",
    description: "Direct, encrypted, serverless file transfer between devices.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen flex flex-col`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster richColors position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
