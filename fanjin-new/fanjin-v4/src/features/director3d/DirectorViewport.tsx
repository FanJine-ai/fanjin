import { Canvas } from "@react-three/fiber";
import { Grid, Line, OrbitControls, TransformControls } from "@react-three/drei";
import { useRef, type ReactNode } from "react";
import * as THREE from "three";
import type {
  DirectorCamera,
  DirectorCharacter,
  DirectorObject,
  DirectorSceneV1,
  DirectorSelection,
  Transform3D,
} from "./directorScene";

type TransformMode = "translate" | "rotate" | "scale";

type TransformableProps = {
  transform: Transform3D;
  selected: boolean;
  mode: TransformMode;
  onCommit: (transform: Transform3D) => void;
  children: ReactNode;
};

function Transformable({ transform, selected, mode, onCommit, children }: TransformableProps) {
  const groupRef = useRef<THREE.Group>(null);
  const group = (
    <group
      ref={groupRef}
      position={transform.position}
      rotation={transform.rotation}
      scale={transform.scale}
    >
      {children}
    </group>
  );
  if (!selected) return group;
  return (
    <TransformControls
      mode={mode}
      onMouseUp={() => {
        const object = groupRef.current;
        if (!object) return;
        onCommit({
          position: [object.position.x, object.position.y, object.position.z],
          rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
          scale: [object.scale.x, object.scale.y, object.scale.z],
        });
      }}
    >
      {group}
    </TransformControls>
  );
}

function CharacterFigure({
  character,
  selected,
  mode,
  onSelect,
  onTransform,
}: {
  character: DirectorCharacter;
  selected: boolean;
  mode: TransformMode;
  onSelect: () => void;
  onTransform: (transform: Transform3D) => void;
}) {
  const height = character.height;
  const headRadius = Math.max(0.12, height * 0.09);
  const torsoHeight = height * 0.46;
  return (
    <Transformable
      transform={character.transform}
      selected={selected}
      mode={mode}
      onCommit={onTransform}
    >
      <group
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <mesh position={[0, height - headRadius * 1.2, 0]} castShadow>
          <sphereGeometry args={[headRadius, 24, 16]} />
          <meshStandardMaterial color="#e7b99a" />
        </mesh>
        <mesh position={[0, height * 0.54, 0]} castShadow>
          <capsuleGeometry args={[height * 0.12, torsoHeight, 8, 16]} />
          <meshStandardMaterial color={character.color} roughness={0.72} />
        </mesh>
        <mesh position={[-height * 0.08, height * 0.18, 0]} castShadow>
          <capsuleGeometry args={[height * 0.045, height * 0.28, 6, 12]} />
          <meshStandardMaterial color="#2b3038" />
        </mesh>
        <mesh position={[height * 0.08, height * 0.18, 0]} castShadow>
          <capsuleGeometry args={[height * 0.045, height * 0.28, 6, 12]} />
          <meshStandardMaterial color="#2b3038" />
        </mesh>
      </group>
    </Transformable>
  );
}

function ObjectGeometry({ kind }: { kind: DirectorObject["kind"] }) {
  if (kind === "sphere") return <sphereGeometry args={[0.5, 28, 20]} />;
  if (kind === "cylinder") return <cylinderGeometry args={[0.5, 0.5, 1, 24]} />;
  if (kind === "cone") return <coneGeometry args={[0.55, 1, 24]} />;
  if (kind === "plane") return <boxGeometry args={[1.2, 0.04, 1.2]} />;
  return <boxGeometry args={[1, 1, 1]} />;
}

function SceneObjectFigure({
  object,
  selected,
  mode,
  onSelect,
  onTransform,
}: {
  object: DirectorObject;
  selected: boolean;
  mode: TransformMode;
  onSelect: () => void;
  onTransform: (transform: Transform3D) => void;
}) {
  return (
    <Transformable
      transform={object.transform}
      selected={selected}
      mode={mode}
      onCommit={onTransform}
    >
      <mesh
        castShadow
        receiveShadow
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <ObjectGeometry kind={object.kind} />
        <meshStandardMaterial color={object.color} roughness={0.68} />
      </mesh>
    </Transformable>
  );
}

function CameraFigure({
  camera,
  selected,
  mode,
  onSelect,
  onPosition,
}: {
  camera: DirectorCamera;
  selected: boolean;
  mode: TransformMode;
  onSelect: () => void;
  onPosition: (position: [number, number, number]) => void;
}) {
  const transform: Transform3D = {
    position: camera.position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
  return (
    <>
      <Transformable
        transform={transform}
        selected={selected}
        mode={mode === "scale" ? "translate" : mode}
        onCommit={(next) => onPosition(next.position)}
      >
        <group
          onPointerDown={(event) => {
            event.stopPropagation();
            onSelect();
          }}
        >
          <mesh castShadow>
            <boxGeometry args={[0.7, 0.42, 0.46]} />
            <meshStandardMaterial color={selected ? "#f59e0b" : "#202631"} />
          </mesh>
          <mesh position={[0, 0, -0.36]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.24, 0.5, 20]} />
            <meshStandardMaterial color="#506078" />
          </mesh>
        </group>
      </Transformable>
      <Line
        points={[camera.position, camera.target]}
        color={selected ? "#f59e0b" : "#6f7f96"}
        lineWidth={1}
        dashed
      />
    </>
  );
}

function SceneLights({ scene }: { scene: DirectorSceneV1 }) {
  return (
    <>
      <hemisphereLight intensity={0.45} color="#dce8ff" groundColor="#171a20" />
      {scene.lights.map((light) => {
        if (light.type === "point") {
          return (
            <pointLight
              key={light.id}
              position={light.position}
              intensity={light.intensity}
              color={light.color}
              castShadow
            />
          );
        }
        if (light.type === "spot") {
          return (
            <spotLight
              key={light.id}
              position={light.position}
              intensity={light.intensity}
              color={light.color}
              angle={0.55}
              penumbra={0.35}
              castShadow
            />
          );
        }
        return (
          <directionalLight
            key={light.id}
            position={light.position}
            intensity={light.intensity}
            color={light.color}
            castShadow
          />
        );
      })}
    </>
  );
}

export type DirectorViewportProps = {
  scene: DirectorSceneV1;
  selection: DirectorSelection;
  transformMode: TransformMode;
  onSelect: (selection: DirectorSelection) => void;
  onCharacterTransform: (id: string, transform: Transform3D) => void;
  onObjectTransform: (id: string, transform: Transform3D) => void;
  onCameraPosition: (id: string, position: [number, number, number]) => void;
};

export default function DirectorViewport(props: DirectorViewportProps) {
  const { scene, selection, transformMode } = props;
  return (
    <Canvas
      shadows
      camera={{ position: [8, 6, 10], fov: 46, near: 0.05, far: 5_000 }}
      onPointerMissed={() => props.onSelect(null)}
      gl={{ antialias: true, preserveDrawingBuffer: false }}
    >
      <color attach="background" args={["#101318"]} />
      <fog attach="fog" args={["#101318", 40, 150]} />
      <SceneLights scene={scene} />
      <Grid
        args={[80, 80]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#303744"
        sectionSize={5}
        sectionThickness={1.1}
        sectionColor="#465269"
        fadeDistance={80}
        infiniteGrid
      />
      {scene.characters.map((character) => (
        <CharacterFigure
          key={character.id}
          character={character}
          selected={selection?.kind === "character" && selection.id === character.id}
          mode={transformMode}
          onSelect={() => props.onSelect({ kind: "character", id: character.id })}
          onTransform={(transform) => props.onCharacterTransform(character.id, transform)}
        />
      ))}
      {scene.objects.map((object) => (
        <SceneObjectFigure
          key={object.id}
          object={object}
          selected={selection?.kind === "object" && selection.id === object.id}
          mode={transformMode}
          onSelect={() => props.onSelect({ kind: "object", id: object.id })}
          onTransform={(transform) => props.onObjectTransform(object.id, transform)}
        />
      ))}
      {scene.cameras.map((camera) => (
        <CameraFigure
          key={camera.id}
          camera={camera}
          selected={selection?.kind === "camera" && selection.id === camera.id}
          mode={transformMode}
          onSelect={() => props.onSelect({ kind: "camera", id: camera.id })}
          onPosition={(position) => props.onCameraPosition(camera.id, position)}
        />
      ))}
      {scene.characters.map((character) => character.path.length > 1 ? (
        <Line
          key={`path-${character.id}`}
          points={character.path.map((point) => point.position)}
          color={character.color}
          lineWidth={2}
        />
      ) : null)}
      <OrbitControls makeDefault minDistance={2} maxDistance={120} target={[0, 1, 0]} />
    </Canvas>
  );
}
