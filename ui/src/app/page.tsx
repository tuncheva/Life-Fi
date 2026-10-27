"use client";
import { ClinicDashboard, HomeDashboard, SchoolDashboard } from "@/components/Dashboards";
import { useLive } from "@/lib/live";

export default function DashboardPage() {
  const { status } = useLive();
  switch (status?.server.profile) {
    case "clinic":
      return <ClinicDashboard />;
    case "school":
      return <SchoolDashboard />;
    default:
      return <HomeDashboard />;
  }
}
