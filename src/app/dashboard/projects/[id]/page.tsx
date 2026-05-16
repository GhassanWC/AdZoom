import { RealEditorPage } from "@/components/dashboard/real-editor/RealEditor";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectEditorPage({ params }: PageProps) {
  const { id } = await params;
  return <RealEditorPage projectId={id} />;
}
