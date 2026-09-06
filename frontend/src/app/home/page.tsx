import type { Metadata } from "next";
import { Landing } from "@/components/landing/landing";
import "./home.css";

export const metadata: Metadata = {
  title: "Magellan — A world within every product",
  description:
    "Go beneath the surface. Discover the components, companies, and connections behind everyday products with Magellan.",
};

export default function HomePage() {
  return <Landing />;
}
