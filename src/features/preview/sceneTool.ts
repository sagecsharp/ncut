/** which tool the scene view's gizmo shows: move (arrows), rotate (rings) or scale (one handle). not persisted. */
import { create } from 'zustand';
import type { SceneTool } from './sceneGizmo';

interface SceneToolState {
  tool: SceneTool;
  setTool(tool: SceneTool): void;
}

export const useSceneTool = create<SceneToolState>()((set) => ({
  tool: 'move',
  setTool(tool) {
    set({ tool });
  },
}));

/** keys of the tools, only while the scene view has the keyboard focus (r and e are global shortcuts elsewhere) */
export const TOOL_KEYS: Readonly<Record<string, SceneTool>> = { w: 'move', e: 'rotate', r: 'scale' };
