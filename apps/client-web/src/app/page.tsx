import CandidateApp from '@/components/CandidateApp';

export default function Page() {
  return <CandidateApp configuredApiBase={process.env.NEXT_PUBLIC_PROCTOR_API_BASE || ''} />;
}
