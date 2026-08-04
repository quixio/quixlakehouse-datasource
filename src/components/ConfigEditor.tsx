import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { InlineField, InlineSwitch, Input, SecretInput } from '@grafana/ui';
import React, { ChangeEvent } from 'react';

import { QuixLakeDataSourceOptions, QuixLakeSecureJsonData } from '../types';

interface Props extends DataSourcePluginOptionsEditorProps<QuixLakeDataSourceOptions, QuixLakeSecureJsonData> {}

const LABEL_WIDTH = 22;

/**
 * Datasource settings page.
 *
 * Functional and unstyled on purpose -- visual design is FrontEndEsthetic's job.
 *
 * The token goes into secureJsonData, never jsonData: Grafana encrypts it at rest
 * and decrypts it only for the backend process, so it is never returned to the
 * browser and never appears in the datasource API response.
 */
export function ConfigEditor(props: Props) {
  const { onOptionsChange, options } = props;
  const { jsonData, secureJsonFields, secureJsonData } = options;

  const setJsonData = (patch: Partial<QuixLakeDataSourceOptions>) => {
    onOptionsChange({ ...options, jsonData: { ...jsonData, ...patch } });
  };

  // URL uses Grafana's standard top-level field, not jsonData.
  const onUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({ ...options, url: event.target.value });
  };

  const onTimeoutChange = (event: ChangeEvent<HTMLInputElement>) => {
    const parsed = parseInt(event.target.value, 10);
    setJsonData({ timeoutSeconds: Number.isNaN(parsed) ? undefined : parsed });
  };

  const onUnionByNameToggle = (event: ChangeEvent<HTMLInputElement>) => {
    setJsonData({ unionByName: event.currentTarget.checked });
  };

  const onTokenChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({ ...options, secureJsonData: { token: event.target.value } });
  };

  const onResetToken = () => {
    onOptionsChange({
      ...options,
      secureJsonFields: { ...options.secureJsonFields, token: false },
      secureJsonData: { ...options.secureJsonData, token: '' },
    });
  };

  return (
    <>
      <InlineField
        label="API URL"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="Base URL of the QuixLake Query Engine, e.g. http://api:80. Point at the API root -- do NOT include a /grafana suffix."
      >
        <Input
          id="config-editor-url"
          onChange={onUrlChange}
          value={options.url ?? ''}
          placeholder="http://api:80"
          width={40}
        />
      </InlineField>

      <InlineField
        label="API token"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="Sent as 'Authorization: Bearer <token>'. Accepts the static API token or a Quix platform token / PAT. Stored encrypted; the browser never receives it back."
      >
        <SecretInput
          required
          id="config-editor-token"
          isConfigured={secureJsonFields?.token}
          value={secureJsonData?.token ?? ''}
          placeholder="QuixLake API token"
          width={40}
          onReset={onResetToken}
          onChange={onTokenChange}
        />
      </InlineField>

      <InlineField
        label="Union by name"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="Merge differing schemas across Parquet files at read time, so schema drift does not break SELECT *. Recommended on."
      >
        <InlineSwitch
          id="config-editor-union-by-name"
          value={jsonData.unionByName ?? true}
          onChange={onUnionByNameToggle}
        />
      </InlineField>

      <InlineField
        label="Query timeout (s)"
        labelWidth={LABEL_WIDTH}
        interactive
        tooltip="Per-query budget. Should be at least as long as the panel's own timeout."
      >
        <Input
          id="config-editor-timeout"
          type="number"
          onChange={onTimeoutChange}
          value={jsonData.timeoutSeconds ?? ''}
          placeholder="60"
          width={40}
        />
      </InlineField>
    </>
  );
}
