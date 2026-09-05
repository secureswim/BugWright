import type { Metadata } from "next";
import "./globals.css";
import "./multi-agent.css";
import "./parallel.css";
export const metadata:Metadata={title:"BugPilot · Autonomous issue resolution",description:"Turn GitHub issues into tested, reviewable draft pull requests."};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
