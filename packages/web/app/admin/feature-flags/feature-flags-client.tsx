"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/api/admin";
import { useAuth } from "@/hooks/use-auth";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, PowerOff, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const formSchema = z.object({
  key: z.string().min(2, "Key must be at least 2 characters."),
  description: z.string().min(1, "Description is required."),
});

type FormValues = z.infer<typeof formSchema>;

export function FeatureFlagsClient() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: flags, isLoading, isError } = useQuery({
    queryKey: ['admin', 'feature-flags'],
    queryFn: () => adminApi.listFlags(),
  });

  const createMutation = useMutation({
    mutationFn: (data: FormValues) => adminApi.createFlag({ ...data, owner: user?.email ?? "admin" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'feature-flags'] });
      setOpen(false);
      form.reset();
    },
  });

  const killMutation = useMutation({
    mutationFn: (key: string) => adminApi.killFlag(key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'feature-flags'] });
    },
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      key: "",
      description: "",
    },
  });

  function onSubmit(values: FormValues) {
    createMutation.mutate(values);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Feature Flags</h1>
          <p className="text-muted-foreground">
            Manage your application feature flags and kill switches.
          </p>
        </div>
        
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Flag
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Feature Flag</DialogTitle>
              <DialogDescription>
                Add a new feature flag to control application behavior.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="key"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Key</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. new-checkout-flow" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Input placeholder="Description of the feature flag" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter className="pt-4">
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending}>
                    {createMutation.isPending && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Create Flag
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Flags List</CardTitle>
          <CardDescription>
            A list of all feature flags in the system. Active flags are evaluated by clients, killed flags always evaluate to false.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center p-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="flex justify-center p-8 text-destructive">
              Failed to load feature flags.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!flags?.length ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      No feature flags found.
                    </TableCell>
                  </TableRow>
                ) : (
                  flags.map((flag) => (
                    <TableRow key={flag.key} data-testid="flag-row">
                      <TableCell className="font-medium">{flag.key}</TableCell>
                      <TableCell>{flag.description}</TableCell>
                      <TableCell>
                        <Badge variant={flag.enabled ? "default" : "destructive"}>
                          {flag.enabled ? "Enabled" : "Off"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={!flag.enabled || killMutation.isPending && killMutation.variables === flag.key}
                          onClick={() => killMutation.mutate(flag.key)}
                        >
                          {killMutation.isPending && killMutation.variables === flag.key ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <PowerOff className="mr-2 h-4 w-4" />
                          )}
                          Kill Switch
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
