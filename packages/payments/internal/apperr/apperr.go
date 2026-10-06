// Package apperr ports libs/common/src/error.types.ts: RFC 7807-shaped errors
// tagged with an Area that decides what the outbox wrapper does with them.
//
//   - DOMAIN    - a business outcome. Must be recorded and sent to the client,
//     never thrown to the consumer boundary.
//   - TRANSIENT - infrastructure hiccup; retried with backoff.
//   - FATAL     - deterministic failure; routed straight to the DLQ.
package apperr

import (
	"errors"
	"net/http"
)

type Area string

const (
	AreaDomain    Area = "DOMAIN"
	AreaFatal     Area = "FATAL"
	AreaTransient Area = "TRANSIENT"
)

type Error struct {
	// Name mirrors the TS class name; it becomes the `type` URI.
	Name   string
	Title  string
	Detail string
	Status int
	Area   Area
	Data   map[string]any
	Causes []error
}

func (e *Error) Error() string   { return e.Detail }
func (e *Error) Unwrap() []error { return e.Causes }

// JSON matches AppError#toJSON: public RFC 7807 fields + area, and with
// includeDebug the data and the serialized cause tree.
func (e *Error) JSON(includeDebug bool) map[string]any {
	payload := map[string]any{
		"type":   "https://api.yourdomain.com/errors/" + e.Name,
		"title":  e.Title,
		"status": e.Status,
		"detail": e.Detail,
		"area":   e.Area,
	}

	if includeDebug {
		if e.Data != nil {
			payload["data"] = e.Data
		}
		if len(e.Causes) > 0 {
			causes := make([]any, 0, len(e.Causes))
			for _, cause := range e.Causes {
				causes = append(causes, serializeCause(cause))
			}
			payload["causes"] = causes
		}
	}

	return payload
}

func serializeCause(err error) any {
	if appErr, ok := err.(*Error); ok {
		return appErr.JSON(true)
	}
	return map[string]any{"type": "error", "detail": err.Error()}
}

// As returns the *Error in err's chain, if any.
func As(err error) (*Error, bool) {
	var appErr *Error
	if errors.As(err, &appErr) {
		return appErr, true
	}
	return nil, false
}

func newError(name, title, detail string, status int, area Area, causes []error) *Error {
	return &Error{Name: name, Title: title, Detail: detail, Status: status, Area: area, Causes: causes}
}

// --- --- --- --- --- Common (error.types.ts) --- --- --- --- --- //

func FatalBadRequest(detail string, causes ...error) *Error {
	return newError("Fatal_BadRequestError", "Bad Request", detail, http.StatusBadRequest, AreaFatal, causes)
}

func FatalInternal(detail string, causes ...error) *Error {
	return newError("Fatal_InternalServerError", "Internal Server Error", detail, http.StatusInternalServerError, AreaFatal, causes)
}

func FatalRetriesExhausted(detail string, causes ...error) *Error {
	return newError("Fatal_RetriesExhaustedError", detail, detail, http.StatusInternalServerError, AreaFatal, causes)
}

// FatalNotFound is DOMAIN-area despite its name - same as the TS class.
func FatalNotFound(title, detail string, causes ...error) *Error {
	return newError("Fatal_NotFoundError", title, detail, http.StatusNotFound, AreaDomain, causes)
}

func FatalDomainErrorIsThrown(causes ...error) *Error {
	return newError(
		"Fatal_DomainErrorIsThrown",
		"Domain error is thrown to the outbox",
		"Domain errors should NEVER reach outbox. They must be hanlded gracefully in the appropriate module",
		http.StatusInternalServerError, AreaFatal, causes,
	)
}

func TransientInternal(detail string, causes ...error) *Error {
	return newError("Transient_InternalServerError", "Transient Error", detail, http.StatusInternalServerError, AreaTransient, causes)
}

// --- --- --- --- --- Payment domain (payment/types.ts) --- --- --- --- --- //

func DomainStripePaymentFailed(detail string, causes ...error) *Error {
	return newError("Domain_StripePaymentFailed", "Stripe payment failed", detail, http.StatusBadRequest, AreaDomain, causes)
}

func DomainCircuitBreakerOpen(causes ...error) *Error {
	return newError("Domain_CircuitBreakerOpenError", "Payment provider unavailable", "Stripe circuit breaker is open", http.StatusServiceUnavailable, AreaDomain, causes)
}

func DomainInsufficientStock(detail string, causes ...error) *Error {
	return newError("Domain_InsufficientStockError", "Insufficient stock", detail, http.StatusConflict, AreaDomain, causes)
}
