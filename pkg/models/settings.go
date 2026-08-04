package models

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// Defaults applied when the config editor left a field empty.
const (
	DefaultTimeoutSeconds = 60
	// DefaultUnionByName differs from the API's own default (false) on purpose.
	// Schema drift across Parquet files should not break SELECT *, which is the
	// same reasoning the Flight server uses (api_client.py:85-88).
	DefaultUnionByName = true
)

// PluginSettings is the non-secret half of the datasource configuration
// (Grafana's `jsonData`). It is safe to log.
//
// The API base URL is NOT here: it lives in Grafana's standard `url` field on
// DataSourceInstanceSettings, which is what gives us TLS options, proxy support and
// the standard HTTP middleware chain for free.
type PluginSettings struct {
	// UnionByName maps to ?union_by_name=true on POST /query.
	UnionByName bool `json:"unionByName"`
	// TimeoutSeconds bounds a single query end to end.
	TimeoutSeconds int `json:"timeoutSeconds"`

	Secrets *SecretPluginSettings `json:"-"`
}

// SecretPluginSettings is the encrypted half (Grafana's `secureJsonData`). It is
// decrypted by Grafana only for the backend process and must never be logged or
// returned to the frontend.
type SecretPluginSettings struct {
	// Token is sent as `Authorization: Bearer <token>`. quix-ts-datalake-api's
	// auth.py accepts either the static API_AUTH_TOKEN or any Quix platform token
	// or PAT via quixportal.validate_permissions, so one field covers both.
	Token string `json:"token"`
}

// Timeout is the per-query budget as a duration.
func (s *PluginSettings) Timeout() time.Duration {
	return time.Duration(s.TimeoutSeconds) * time.Second
}

// LoadPluginSettings decodes both halves of the datasource configuration and
// applies defaults. It never returns the token in an error message.
func LoadPluginSettings(source backend.DataSourceInstanceSettings) (*PluginSettings, error) {
	// unionByName defaults to true, so start from the default and let explicit
	// JSON override it rather than relying on Go's zero value.
	settings := PluginSettings{
		UnionByName:    DefaultUnionByName,
		TimeoutSeconds: DefaultTimeoutSeconds,
	}

	if len(source.JSONData) > 0 {
		if err := json.Unmarshal(source.JSONData, &settings); err != nil {
			return nil, fmt.Errorf("could not unmarshal PluginSettings json: %w", err)
		}
	}

	if settings.TimeoutSeconds <= 0 {
		settings.TimeoutSeconds = DefaultTimeoutSeconds
	}

	settings.Secrets = loadSecretPluginSettings(source.DecryptedSecureJSONData)

	return &settings, nil
}

func loadSecretPluginSettings(source map[string]string) *SecretPluginSettings {
	return &SecretPluginSettings{
		Token: source["token"],
	}
}
