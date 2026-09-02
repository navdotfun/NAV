import { useCallback, useRef, useState } from "react";

export function useToast(): { toast: React.ReactNode; show: (msg: string) => void } {
  const [msg, setMsg] = useState("");
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((m: string) => {
    setMsg(m);
    setVisible(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 2600);
  }, []);

  const toast = <div className={`toast ${visible ? "show" : ""}`} role="status">{msg}</div>;
  return { toast, show };
}
