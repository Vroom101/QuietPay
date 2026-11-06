import type { SVGProps } from "react";

const paths = {
  search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4 4" /></>,
  orders: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6m-6 4h6m-6 4h4" /></>,
  heart: <path d="M20.5 8.8c0 4.5-8.5 9.5-8.5 9.5s-8.5-5-8.5-9.5a4.5 4.5 0 0 1 8.5-2.1 4.5 4.5 0 0 1 8.5 2.1Z" />,
  bag: <><path d="M4.5 8h15l1 12h-17l1-12Z" /><path d="M9 9V6a3 3 0 0 1 6 0v3" /></>,
  store: <><path d="M4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9M3 10l2-5h14l2 5" /><path d="M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" /></>,
  left: <path d="m14 6-6 6 6 6" />,
  right: <path d="m10 6 6 6-6 6" />,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  refund: <><path d="M4 9h11a5 5 0 1 1 0 10h-3M8 5 4 9l4 4" /></>,
  repeat: <><path d="M4 10V8a3 3 0 0 1 3-3h12m-3-3 3 3-3 3M20 14v2a3 3 0 0 1-3 3H5m3 3-3-3 3-3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  spark: <path d="m13 2-8 12h6l-1 8 9-12h-7l1-8Z" />,
  team: <><circle cx="12" cy="8" r="3" /><path d="M6 20v-2a6 6 0 0 1 12 0v2H6ZM6 5a3 3 0 0 0 0 6m12-6a3 3 0 0 1 0 6M5 13a4 4 0 0 0-3 4v2m17-6a4 4 0 0 1 3 4v2" /></>,
  shield: <path d="M12 22s7-3 7-9V5l-7-3-7 3v8c0 6 7 9 7 9Zm-3-10 2 2 4-4" />,
  layers: <path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" />,
} satisfies Record<string, React.ReactNode>;

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
