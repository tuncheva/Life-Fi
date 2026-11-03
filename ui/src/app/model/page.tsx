"use client";
// The dashboard again, with the 3D view driven by the taught-spot model
// (engine/lifefi/spots.py) instead of the distance estimate, to compare the two.
import { ClinicDashboard, HomeDashboard, SchoolDashboard } from "@/components/Dashboards";
import { useLive } from "@/lib/live";

export default function ModelDashboardPage() {
  const { status } = useLive();
  switch (status?.server.profile) {
    case "clinic":
      return <ClinicDashboard source="model" />;
    case "school":
      return <SchoolDashboard source="model" />;
    default:
      return <HomeDashboard source="model" />;
  }
}
