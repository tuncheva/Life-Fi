import { BreathingCard, CsiHeatmap, HealthCard, MotionCard, StateCard } from "@/components/Cards";

export default function HomePage() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <StateCard />
      <MotionCard />
      <HealthCard />
      <BreathingCard />
      <CsiHeatmap />
    </div>
  );
}
