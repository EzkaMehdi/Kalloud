import { Coffee } from "lucide-react";
import { Navigation } from "./navigation";
export function Shell({children}:{children:React.ReactNode}){return <main className="shell"><header className="topbar"><div className="brand"><span className="brand-mark"><Coffee size={18}/></span>Kalloud</div><div className="avatar">MK</div></header>{children}<Navigation/></main>}
