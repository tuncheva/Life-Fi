"use client";
import { ClinicDashboard, HomeDashboard, SchoolDashboard } from "@/components/Dashboards";
import { useLiveSlow } from "@/lib/live";

export default function DashboardPage() {
  const { status } = useLiveSlow();
  switch (status?.server.profile) {
    case "clinic":
      return <ClinicDashboard />;
    case "school":
      return <SchoolDashboard />;
    default:
      return <HomeDashboard />;
  }
}
