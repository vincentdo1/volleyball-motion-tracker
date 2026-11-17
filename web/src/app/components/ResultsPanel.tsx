import { Layers, Table2, Users } from 'lucide-react';
import { Tab, Tabs, TabsList, TabsPanel } from '@/ui/tabs';
import type { TrackInfo } from '../results/tracks';
import { type PanelTab, useViewStore } from '../stores/view';
import { DataPanel } from './DataPanel';
import { LayersPanel } from './LayersPanel';
import { PlayersPanel } from './PlayersPanel';

export interface ResultsPanelProps {
  readonly tracks: readonly TrackInfo[];
  readonly live: boolean;
}

/** Players, Layers and Data (05 §4.5). Lives in a rail on wide screens and in a sheet on small ones. */
export function ResultsPanel({ tracks, live }: ResultsPanelProps) {
  const tab = useViewStore((s) => s.panelTab);
  const setTab = useViewStore((s) => s.setPanelTab);
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="flex min-h-0 flex-1 flex-col gap-4">
      <TabsList>
        <Tab value="players">
          <Users aria-hidden className="size-4" />
          Players
        </Tab>
        <Tab value="layers">
          <Layers aria-hidden className="size-4" />
          Layers
        </Tab>
        <Tab value="data">
          <Table2 aria-hidden className="size-4" />
          Data
        </Tab>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TabsPanel value="players">
          <PlayersPanel tracks={tracks} live={live} />
        </TabsPanel>
        <TabsPanel value="layers">
          <LayersPanel />
        </TabsPanel>
        <TabsPanel value="data">
          <DataPanel />
        </TabsPanel>
      </div>
    </Tabs>
  );
}
