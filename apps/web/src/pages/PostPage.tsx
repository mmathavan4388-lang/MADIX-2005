import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ErrorState, Loading } from '../components/ui';
import { PostCard, type Post } from '../components/PostCard';

export default function PostPage() {
  const { id } = useParams(); const [p, setP] = useState<Post | null>(null); const [err, setErr] = useState<unknown>(null);
  const load = () => { setErr(null); api(`/posts/${id}`).then(setP).catch(setErr); };
  useEffect(load, [id]);  // eslint-disable-line react-hooks/exhaustive-deps
  return err ? <ErrorState error={err} onRetry={load} /> : p ? <PostCard post={p} /> : <Loading rows={1} />;
}
