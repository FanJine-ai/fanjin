import type { ChangeEvent, RefObject } from "react";

type Props = { quickRef: RefObject<HTMLInputElement | null>; storyboardRef: RefObject<HTMLInputElement | null>; productVideoRef: RefObject<HTMLInputElement | null>; productAssetRef: RefObject<HTMLInputElement | null>; onQuick: (event: ChangeEvent<HTMLInputElement>) => void; onStoryboard: (event: ChangeEvent<HTMLInputElement>) => void; onProductVideo: (event: ChangeEvent<HTMLInputElement>) => void; onProductAsset: (event: ChangeEvent<HTMLInputElement>) => void; };

export function CanvasHiddenUploadInputs({ quickRef, storyboardRef, productVideoRef, productAssetRef, onQuick, onStoryboard, onProductVideo, onProductAsset }: Props) {
  return <><input ref={quickRef} type="file" accept="image/*,video/*" className="hidden" onChange={onQuick} /><input ref={storyboardRef} type="file" accept="image/*" className="hidden" onChange={onStoryboard} /><input ref={productVideoRef} type="file" accept="video/*" className="hidden" onChange={onProductVideo} /><input ref={productAssetRef} type="file" accept="image/*" className="hidden" onChange={onProductAsset} /></>;
}
