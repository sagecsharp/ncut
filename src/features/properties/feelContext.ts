import { createContext, useContext, useMemo } from 'react';
import { useEditor } from '../../store/editorStore';
import { DEFAULT_FEEL_CTX, feelCtx, type FeelCtx } from './fieldFeel';

export const FeelContext = createContext<FeelCtx>(DEFAULT_FEEL_CTX);

export function useFeelCtx(): FeelCtx {
  return useContext(FeelContext);
}

/** for the inspector roots: W / H from the open project, memoized on them */
export function useCanvasFeelCtx(): FeelCtx {
  const W = useEditor((s) => s.project?.width ?? 1920);
  const H = useEditor((s) => s.project?.height ?? 1080);
  return useMemo(() => feelCtx(W, H), [W, H]);
}
