// Package config mirrors the subset of packages/backend/.env the payment
// processor needs, using the same variable names as the NestJS app so both
// implementations can run against one .env.
package config

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	NodeEnv string

	DatabaseURL string
	DBMaxConns  int32
	// SimpleProtocol disables server-side prepared statements, needed when
	// DB_PORT points at a PgBouncer in transaction mode that doesn't track them.
	DBSimpleProtocol bool

	KafkaBrokers   []string
	KafkaGroupID   string
	KafkaAPIKey    string
	KafkaAPISecret string

	// ConsumerWorkers shards each polled batch by idempotency key across this
	// many goroutines. 1 = strictly sequential, like the NestJS consumer.
	ConsumerWorkers int

	StripeSecretKey  string
	StripeAPIVersion string
	StripeTimeout    time.Duration
	IsLoadTest       bool

	OtelEnabled bool
	ServiceName string
}

// IsLocalKafka matches payment-processor/main.ts: plaintext for local/test,
// SASL_SSL (Confluent) everywhere else.
func (c Config) IsLocalKafka() bool {
	return c.NodeEnv == "local" || c.NodeEnv == "test"
}

func Load() (Config, error) {
	loadDotEnv(getEnv("ENV_FILE", "../backend/.env"))

	var missing []string
	require := func(key string) string {
		v := os.Getenv(key)
		if v == "" {
			missing = append(missing, key)
		}
		return v
	}

	nodeEnv := require("NODE_ENV")
	dbHost := require("DB_HOST")
	dbPort := require("DB_PORT")
	dbUser := require("DB_USERNAME")
	dbPassword := require("DB_PASSWORD")
	dbName := require("DB_NAME")
	kafkaBroker := require("KAFKA_BROKER")

	cfg := Config{
		NodeEnv:          nodeEnv,
		DBMaxConns:       int32(getInt("DB_POOL_MAX", 20)),
		DBSimpleProtocol: getBool("PG_SIMPLE_PROTOCOL", false),
		KafkaGroupID:     getEnv("KAFKA_GROUP_ID", "payment-processor"),
		KafkaAPIKey:      os.Getenv("KAFKA_API_KEY"),
		KafkaAPISecret:   os.Getenv("KAFKA_API_SECRET"),
		ConsumerWorkers:  getInt("CONSUMER_WORKERS", 1),
		StripeSecretKey:  os.Getenv("STRIPE_SECRET_KEY"),
		StripeAPIVersion: getEnv("STRIPE_API_VERSION", "2026-03-25.dahlia"),
		StripeTimeout:    15 * time.Second,
		IsLoadTest:       getBool("IS_LOAD_TEST", false),
		OtelEnabled:      getBool("OTEL_ENABLED", true),
		ServiceName:      getEnv("OTEL_SERVICE_NAME", "payment-service-go"),
	}

	for _, broker := range strings.Split(kafkaBroker, ",") {
		if b := strings.TrimSpace(broker); b != "" {
			cfg.KafkaBrokers = append(cfg.KafkaBrokers, b)
		}
	}

	if !cfg.IsLoadTest && cfg.StripeSecretKey == "" {
		missing = append(missing, "STRIPE_SECRET_KEY")
	}
	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing required env vars: %s", strings.Join(missing, ", "))
	}
	if cfg.ConsumerWorkers < 1 {
		cfg.ConsumerWorkers = 1
	}

	sslMode := getEnv("DB_SSLMODE", "disable")
	if nodeEnv == "production" && os.Getenv("DB_SSLMODE") == "" {
		sslMode = "require"
	}
	cfg.DatabaseURL = (&url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(dbUser, dbPassword),
		Host:     dbHost + ":" + dbPort,
		Path:     "/" + dbName,
		RawQuery: "sslmode=" + sslMode,
	}).String()

	return cfg, nil
}

// loadDotEnv sets KEY=VALUE pairs from path without overriding variables
// already present in the environment. A missing file is not an error.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(strings.TrimPrefix(key, "export "))
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, value)
		}
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getInt(key string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return v
	}
	return fallback
}

func getBool(key string, fallback bool) bool {
	if v, err := strconv.ParseBool(os.Getenv(key)); err == nil {
		return v
	}
	return fallback
}
