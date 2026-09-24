import { Suspense } from 'react';
import { CharacterProfileScreen } from '@/features/characters/character-profile';

export const metadata = { title: 'Character Profile' };

export default async function CharacterPage({ params }: { params: Promise<{ projectId: string; characterId: string }> }) {
  const { projectId, characterId } = await params;
  return (
    <Suspense>
      <CharacterProfileScreen projectId={projectId} characterId={characterId} />
    </Suspense>
  );
}
