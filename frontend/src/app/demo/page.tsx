import type { Metadata } from "next";
import { Experience } from "@/components/experience/experience";

export const metadata: Metadata = {
  title: "Magellan — iPhone Demo",
  description: "Explore the components and supplier connections inside an iPhone.",
};

export default function DemoPage() {
  return <Experience />;
}
