import { PluginConfig } from '../config/schema.js';
import { PatternRedactorPlugin } from './pattern-redactor.js';
import { ToolResultPlugin } from './types.js';

export function createPlugins(configs: PluginConfig[]): ToolResultPlugin[] {
  return configs
    .filter((config) => config.enabled)
    .map((config) => {
      switch (config.name) {
        case 'pattern-redactor':
          return new PatternRedactorPlugin(config);
      }
    });
}
