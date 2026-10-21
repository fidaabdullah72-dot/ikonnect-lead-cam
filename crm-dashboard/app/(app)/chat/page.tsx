import { Suspense } from 'react';
import { ChatView } from '@/components/chat/chat-view';
import { PageSpinner } from '@/components/ui/spinner';

export const metadata = { title: 'Team chat' };

export default function ChatPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <ChatView />
    </Suspense>
  );
}
