'use client';

import { useState, useTransition, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, SlidersHorizontal, MapPin, Loader2, X } from 'lucide-react';
import { cn, formatMoney } from '@/lib/utils';
import { ProductCard } from '@/components/product-card';
import { hitToCard, suggestionsFrom, type SearchResponse } from '@/lib/api/catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const fetchProducts = async (params: any) => {
  const queryParams = new URLSearchParams();
  if (params.q) queryParams.set('q', params.q);
  if (params.category && params.category.length > 0) {
    queryParams.set('category', params.category.join(','));
  }
  if (params.priceRange && params.priceRange.length === 2) {
    queryParams.set('priceMin', (params.priceRange[0] * 100).toString());
    queryParams.set('priceMax', (params.priceRange[1] * 100).toString());
  }
  if (params.rating) {
    queryParams.set('ratingMin', params.rating.toString());
  }
  if (params.sort) {
    queryParams.set('sort', params.sort);
  }
  
  try {
    const res = await fetch(`/api/products/search?${queryParams.toString()}`);
    if (!res.ok) throw new Error('Failed to fetch products');
    const data: SearchResponse = await res.json();
    return {
      items: (data.hits || []).map(hitToCard),
      total: data.total || 0,
      facets: data.facets || {}
    };
  } catch (error) {
    console.error(error);
    return { items: [], total: 0, facets: {} };
  }
};

const fetchAutocomplete = async (query: string) => {
  if (!query) return [];
  try {
    const res = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    return suggestionsFrom(await res.json());
  } catch (error) {
    console.error(error);
    return [];
  }
};

function SearchContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [inputValue, setInputValue] = useState(query);
  const [debouncedInput, setDebouncedInput] = useState(inputValue);
  const [openAutocomplete, setOpenAutocomplete] = useState(false);
  const [filters, setFilters] = useState({
    category: searchParams.get('category')?.split(',') || [],
    priceRange: [Number(searchParams.get('priceMin') || 0), Number(searchParams.get('priceMax') || 1000)],
    rating: Number(searchParams.get('rating') || 0),
    nearMe: searchParams.get('nearMe') === 'true',
    sort: searchParams.get('sort') || 'relevance'
  });

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedInput(inputValue), 300);
    return () => clearTimeout(timer);
  }, [inputValue]);

  const { data: autocompleteResults = [] } = useQuery({
    queryKey: ['autocomplete', debouncedInput],
    queryFn: () => fetchAutocomplete(debouncedInput),
    enabled: debouncedInput.length > 1,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['search', query, filters],
    queryFn: () => fetchProducts({ q: query, ...filters }),
  });

  const updateSearch = (newParams: any) => {
    startTransition(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (newParams.q !== undefined) {
        if (newParams.q) params.set('q', newParams.q);
        else params.delete('q');
      }
      if (newParams.category !== undefined) {
        if (newParams.category.length) params.set('category', newParams.category.join(','));
        else params.delete('category');
      }
      if (newParams.sort) params.set('sort', newParams.sort);
      if (newParams.priceRange) {
        params.set('priceMin', newParams.priceRange[0].toString());
        params.set('priceMax', newParams.priceRange[1].toString());
      }
      if (newParams.nearMe !== undefined) {
        if (newParams.nearMe) params.set('nearMe', 'true');
        else params.delete('nearMe');
      }
      
      router.push(`/search?${params.toString()}`);
    });
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setQuery(inputValue);
    updateSearch({ q: inputValue });
    setOpenAutocomplete(false);
  };

  const toggleCategory = (cat: string) => {
    const newCats = filters.category.includes(cat)
      ? filters.category.filter(c => c !== cat)
      : [...filters.category, cat];
    const newFilters = { ...filters, category: newCats };
    setFilters(newFilters);
    updateSearch(newFilters);
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      {/* Search Header */}
      <div className="flex flex-col md:flex-row gap-4 items-center mb-8">
        <form onSubmit={handleSearchSubmit} className="relative w-full max-w-2xl flex-1">
          <Popover open={openAutocomplete && debouncedInput.length > 1} onOpenChange={setOpenAutocomplete}>
            <PopoverTrigger asChild>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                <Input 
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    setOpenAutocomplete(true);
                  }}
                  onFocus={() => setOpenAutocomplete(true)}
                  placeholder="Search products, categories..." 
                  className="pl-10 pr-12 py-6 text-lg rounded-full shadow-sm"
                />
                {inputValue && (
                  <Button 
                    type="button" 
                    variant="ghost" 
                    size="icon" 
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full"
                    onClick={() => {
                      setInputValue('');
                      setQuery('');
                      updateSearch({ q: '' });
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </PopoverTrigger>
            <PopoverContent 
              className="w-[var(--radix-popover-trigger-width)] p-0" 
              align="start"
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <Command>
                <CommandList>
                  {autocompleteResults.length === 0 && debouncedInput.length > 1 ? (
                    <CommandEmpty>No suggestions found.</CommandEmpty>
                  ) : (
                    <CommandGroup heading="Suggestions">
                      {autocompleteResults.map((result) => (
                        <CommandItem 
                          key={result} 
                          value={result}
                          onSelect={(val) => {
                            setInputValue(val);
                            setQuery(val);
                            updateSearch({ q: val });
                            setOpenAutocomplete(false);
                          }}
                        >
                          <Search className="mr-2 h-4 w-4" />
                          {result}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </form>

        <div className="flex items-center gap-2 w-full md:w-auto justify-between">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" className="md:hidden">
                <SlidersHorizontal className="mr-2 h-4 w-4" /> Filters
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[300px] sm:w-[400px]">
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
              </SheetHeader>
              <div className="py-6 overflow-y-auto">
                <FiltersContent filters={filters} toggleCategory={toggleCategory} setFilters={setFilters} updateSearch={updateSearch} />
              </div>
            </SheetContent>
          </Sheet>

          <Select 
            value={filters.sort} 
            onValueChange={(val) => {
              setFilters({ ...filters, sort: val });
              updateSearch({ ...filters, sort: val });
            }}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="relevance">Relevance</SelectItem>
              <SelectItem value="price-asc">Price: Low to High</SelectItem>
              <SelectItem value="price-desc">Price: High to Low</SelectItem>
              <SelectItem value="newest">Newest Arrivals</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex gap-8">
        {/* Desktop Sidebar Filters */}
        <aside className="hidden md:block w-64 shrink-0">
          <div className="sticky top-24">
            <h2 className="font-semibold text-lg mb-4">Filters</h2>
            <FiltersContent filters={filters} toggleCategory={toggleCategory} setFilters={setFilters} updateSearch={updateSearch} />
          </div>
        </aside>

        {/* Results Grid */}
        <main className="flex-1">
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-xl font-medium">
              {query ? `Results for "${query}"` : 'All Products'}
              {!isLoading && data && <span className="text-muted-foreground text-sm ml-2">({data.total} results)</span>}
            </h1>
            {isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="space-y-4">
                  <Skeleton className="aspect-square w-full rounded-xl" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                  <Skeleton className="h-5 w-1/4 mt-4" />
                </div>
              ))}
            </div>
          ) : data?.items.length === 0 ? (
            <div className="text-center py-24 px-4 bg-muted/20 rounded-xl border border-dashed">
              <Search className="mx-auto h-12 w-12 text-muted-foreground mb-4 opacity-20" />
              <h3 className="text-lg font-medium mb-2">No results found</h3>
              <p className="text-muted-foreground max-w-md mx-auto mb-6">
                We couldn't find anything matching your search. Try adjusting your filters or search terms.
              </p>
              <Button onClick={() => {
                setQuery('');
                setInputValue('');
                setFilters({ ...filters, category: [] });
                router.push('/search');
              }}>
                Clear all filters
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
                {data?.items.map((product: any) => (
                  <ProductCard key={product.id} {...product} />
                ))}
              </div>
              
              {data && data.total > data.items.length && (
                <div className="mt-12 text-center">
                  <Button variant="outline" size="lg" className="min-w-[200px]">
                    Load More
                  </Button>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function FiltersContent({ filters, toggleCategory, setFilters, updateSearch }: any) {
  const categories = [
    { id: 'clothing', label: 'Clothing', count: 124 },
    { id: 'shoes', label: 'Shoes', count: 86 },
    { id: 'accessories', label: 'Accessories', count: 342 },
    { id: 'home', label: 'Home & Living', count: 56 },
    { id: 'art', label: 'Art & Collectibles', count: 21 },
  ];

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h3 className="font-medium text-sm">Categories</h3>
        <div className="space-y-3">
          {categories.map(cat => (
            <div key={cat.id} className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Checkbox 
                  id={`cat-${cat.id}`} 
                  checked={filters.category.includes(cat.id)}
                  onCheckedChange={() => toggleCategory(cat.id)}
                />
                <Label htmlFor={`cat-${cat.id}`} className="text-sm font-normal cursor-pointer">
                  {cat.label}
                </Label>
              </div>
              <span className="text-xs text-muted-foreground">{cat.count}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="font-medium text-sm">Price Range</h3>
        <Slider 
          value={filters.priceRange}
          onValueChange={(val) => setFilters({ ...filters, priceRange: val })}
          onValueCommit={(val) => updateSearch({ ...filters, priceRange: val })}
          max={1000} 
          step={10} 
          className="my-6"
        />
        <div className="flex items-center justify-between gap-4">
          <Input 
            type="number" 
            placeholder="Min" 
            className="h-8" 
            value={filters.priceRange[0]}
            onChange={(e) => setFilters({ ...filters, priceRange: [Number(e.target.value), filters.priceRange[1]] })}
            onBlur={() => updateSearch({ ...filters })}
          />
          <span className="text-muted-foreground">-</span>
          <Input 
            type="number" 
            placeholder="Max" 
            className="h-8" 
            value={filters.priceRange[1]}
            onChange={(e) => setFilters({ ...filters, priceRange: [filters.priceRange[0], Number(e.target.value)] })}
            onBlur={() => updateSearch({ ...filters })}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="nearMe-switch" className="font-medium text-sm">Near Me</Label>
            <p className="text-xs text-muted-foreground">Local pickup available</p>
          </div>
          <Switch 
            id="nearMe-switch"
            checked={filters.nearMe} 
            onCheckedChange={(c) => {
              const newFilters = { ...filters, nearMe: c };
              setFilters(newFilters);
              updateSearch(newFilters);
            }} 
          />
        </div>
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SearchContent />
    </Suspense>
  )
}
