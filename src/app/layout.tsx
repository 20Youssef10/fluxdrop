import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/fluxdrop/theme-provider";
import { ServiceWorkerRegister } from "@/components/fluxdrop/sw-register";

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
  manifest: "/manifest.json",
  icons: {
    icon: "/logo.svg",
    apple: "/logo.svg",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "FluxDrop",
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

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0f0d" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
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
          <ServiceWorkerRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
