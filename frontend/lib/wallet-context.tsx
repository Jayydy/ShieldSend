"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface WalletContextValue {
  publicKey: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue>({
  publicKey: null,
  connect: async () => {},
  disconnect: () => {},
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);

  const connect = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const freighter = (window as any).freighter;
    if (!freighter) throw new Error("Freighter not installed. Visit freighter.app");
    await freighter.requestAccess();
    const { publicKey: pk } = await freighter.getPublicKey();
    setPublicKey(pk as string);
  }, []);

  const disconnect = useCallback(() => setPublicKey(null), []);

  return (
    <WalletContext.Provider value={{ publicKey, connect, disconnect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
