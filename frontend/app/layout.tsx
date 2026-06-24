import type { ReactNode } from "react";
import { WalletProvider } from "../lib/wallet-context";
import "./globals.css";

export const metadata = {
  title: "ShieldSend — Private Remittances on Stellar",
  description: "ZK-powered cross-border payments. Amounts hidden. Identity hidden. Proof on-chain.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
